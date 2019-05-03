'use strict'
const moment = require('moment')
const url = require('url')
const { URL } = require('url')
const { canonicalDomain, CookieJar } = require('tough-cookie')
const fun = require('funstream')
const rethrow = require('./rethrow.js')

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
async function timeout (ms) {
  const err = new Error('timeout')
  err.name = 'Timeout'
  err.code = 'ETIMEOUT'
  Error.captureStackTrace(err, timeout)
  await sleep(ms)
  throw err
}

let queueRunner
const state = {
  hosts: {},
  inflight: {},
  enqueued: 0,
  flying: 0,
  nextReq: null,
  lastReq: null,
  lastComplete: null,
  config: null
}

module.exports = (fetch, _config) => {
  const config = Object.assign({sites: {}}, _config || {})
  if (!config.global) config.global = {}
  if (!config.global.limits) config.global.limits = {}
  if (!config.sites.default) config.sites.default = {}
  state.config = config
  for (let name of Object.keys(config.sites)) {
    if (name === 'default') continue
    const site = config.sites[name]
    if (!site.cookies) continue
    site.cookieJar = new CookieJar()
    for (let cookie of site.cookies) {
      site.cookieJar.setCookieSync(`${cookie}; Domain=${name}`, `http://${name}`)
    }
    delete site.cookies
  }
  async function backoffFetch (uri, opts) {
    if (state.inflight[uri]) return state.inflight[uri]
    const site = siteConfig(uri, config)
    if (!site.cookieJar) site.cookieJar = new CookieJar()
    state.inflight[uri] = enqueue(fetch, uri, {cookieJar: site.cookieJar, ...opts})
    try {
      return await state.inflight[uri]
    } finally {
      delete state.inflight[uri]
    }
  }
  backoffFetch.defaults = fetch.defaults

  return backoffFetch
}
module.exports.state = state

function enqueue (fetch, uri, opts) {
  const info = hostState(uri)
  ++state.enqueued
  return new Promise(resolve => {
    info.queue.push({
      fetch,
      uri,
      opts,
      done: _ => {
        if (--state.enqueued === 0) stopRunner()
        return resolve(_)
      }
    })
    startRunner()
  })
}

function startRunner () {
  if (queueRunner) return
  queueRunner = setInterval(runQueue, 150)
  runQueue()
}

function stopRunner () {
  if (!queueRunner) return
  clearInterval(queueRunner)
  queueRunner = null
}

function hostname (uri) {
  return new URL(uri).host
}

function hostState (uri) {
  const host = hostname(uri)
  if (!state.hosts[host]) state.hosts[host] = {name: host, queue: [], flying: 0, nextReq: null, lastReq: null, lastComplete: null, lastErr: null}
  return state.hosts[host]
}

let last = Number(moment())
async function runQueue () {
  const now = Number(moment())

  if (state.nextReq && state.nextReq > now) return

  if (state.config.global.limits.concurrent && (state.flying >= state.config.global.limits.concurrent)) {
    process.emit('warn', 'Global: Defering due to global concurrency controls', state.flying)
    return
  }

  if (state.config.global.limits['per-second']) {
    const secondsPerRequest = 1 / state.config.global.limits['per-second']
    const sinceLast = state.lastReq ? (Number(moment()) - state.lastReq) / 1000 : Infinity
    const secondsBetweenRequests = state.config.global.limits['minimum-gap'] || 0
    const sinceLastComplete = state.lastComplete ? (Number(moment()) - state.lastComplete) / 1000 : Infinity
    if (sinceLast < secondsPerRequest) {
      process.emit('warn', `Global: Delaying for ${secondsPerRequest - sinceLast}s due to rate controls (${secondsPerRequest} versus ${sinceLast}`)
      const next = now + ((secondsPerRequest - sinceLast) * 1000)
      if (!state.nextReq || next > state.nextReq) state.nextReq = next
      return
    }
    if (sinceLastComplete < secondsBetweenRequests) {
      process.emit('warn', `Global: Delaying for ${secondsBetweenRequests - sinceLastComplete}s due to rate completion controls`)
      const next = now + ((secondsBetweenRequests - sinceLastComplete) * 1000)
      if (!state.nextReq || next > state.nextReq) state.nextReq = next
      return
    }
  }

  for (let name of Object.keys(state.hosts)) {
    const host = state.hosts[name]
    if (host.nextReq && host.nextReq > now) continue
    host.lastErr = null
    while (host.queue.length) {
      const info = host.queue[0]
      const perSiteLimits = {...defaultLimits(state.config), ...siteLimits(info.uri, state.config)}
      const maxRetries = perSiteLimits['retries'] || 5
      if (host.flying >= (perSiteLimits['concurrent'] || 4)) {
        process.emit('warn', 'Defering due to concurrency controls', host.name, host.flying)
        host.lastErr = 'Limit: Concurrency'
        break
      }
      const secondsPerRequest = 1 / (perSiteLimits['per-second'] || 8)
      const sinceLast = host.lastReq ? (Number(moment()) - host.lastReq) / 1000 : Infinity
      const secondsBetweenRequests = perSiteLimits['minimum-gap'] || 0
      const sinceLastComplete = host.lastComplete ? (Number(moment()) - host.lastComplete) / 1000 : Infinity
      if (sinceLast < secondsPerRequest) {
        process.emit('warn', `Delaying for ${secondsPerRequest - sinceLast}s due to rate controls (${secondsPerRequest} versus ${sinceLast}`)
        const next = now + ((secondsPerRequest - sinceLast) * 1000)
        host.nextReq = next
        host.lastErr = 'Limit: Request Rate'
        break
      }
      if (sinceLastComplete < secondsBetweenRequests) {
        process.emit('warn', `Delaying for ${secondsBetweenRequests - sinceLastComplete}s due to rate completion controls`)
        const next = now + ((secondsBetweenRequests - sinceLastComplete) * 1000)
        host.nextReq = next
        host.lastErr = 'Limit: Completion Rate'
        break
      }
      host.queue.shift()
      host.lastReq = now
      if (!state.lastReq || last > state.lastReq) state.lastReq = now
      ++host.flying
      ++state.flying
      const fetchOpts = {...info.opts}
      const cj = info.opts.cookieJar
      if (cj) {
        if (!fetchOpts.headers) fetchOpts.headers = {}
        fetchOpts.headers['Cookie'] = cj.getCookieStringSync(info.uri)
      }
      let res, err
      try {
        res = await Promise.race([timeout((perSiteLimits['timeout'] * 1000) || 15000), info.fetch(info.uri, fetchOpts)])
        if (res.headers && res.headers.has('set-cookie')) {
          for (let rawCookie of res.headers.raw()['set-cookie']) {
            try {
              await setCookieP(info.opts.cookieJar, rawCookie, res.url || info.uri)
            } catch (_) { /* ignore */ }
          }
        }
      } catch (_) {
        err = _
      }
      --host.flying
      --state.flying
      state.lastComplete = host.lastComplete = Number(moment())
      if (!err && res.status < 400) {
        info.done(res)
        return
      }
      if (!info.tries) info.tries = 0
      ++info.tries
      if (info.tries > maxRetries) return info.done(Promise.reject(rethrow(err) || resToError(res, info.uri) || new Error(`Ran out of retries ${info.tries} > ${maxRetries}`)))
      const retryDelay = 1500 + (500 * (info.tries ** 2))
      if (res && res.status >= 500) {
        process.emit('warn', `Server error on ${info.uri} sleeping`, retryDelay / 1000, 'seconds')
        host.queue.unshift(info)
        host.nextReq = Number(moment()) + retryDelay
        host.lastErr = 'Error: Server Error'
        if (res && res.body) await fun(res.body).forEach(_ => {}).catch(_ => {})
      } else if ((res && res.status === 408) || (err && (err.code === 'ETIMEOUT' || err.type === 'body-timeout' || /timeout/i.test(err.message)))) {
        process.emit('warn', `Timeout on ${info.uri} sleeping`, retryDelay / 1000, 'seconds')
        host.queue.unshift(info)
        host.nextReq = Number(moment()) + retryDelay
        host.lastErr = 'Error: Timeout'
        if (res && res.body) await fun(res.body).forEach(_ => {}).catch(_ => {})
      } else if (res && res.status === 429) {
        const retryAfter = res.headers['retry-after']
        let retryTime = 3000 + (500 * (info.tries ** 2))
        if (retryAfter) {
          if (/^\d+$/.test(retryAfter)) {
            retryTime = Number(retryAfter) * 1000
          } else {
            retryTime = (moment().unix() - moment.utc(retryAfter, 'ddd, DD MMM YYYY HH:mm:ss ZZ').unix()) * 1000
          }
        }
        process.emit('warn', 'Request backoff requested, sleeping', retryTime / 1000, 'seconds', `(${retryAfter ? 'at: ' + retryAfter + ', ' : ''}now: ${moment.utc()})`)
        host.queue.unshift(info)
        host.nextReq = Number(moment()) + retryTime
        host.lastErr = 'Error: 429 Too Many Requests'
        if (res && res.body) await fun(res.body).forEach(_ => {}).catch(_ => {})
      } else if (err) {
        if (res && res.body) await fun(res.body).forEach(_ => {}).catch(_ => {})
        if (err.code === 'HPE_HEADER_OVERFLOW') {
          info.done({
            status: 502,
            statusText: 'Reponse headers too large',
            body: fun('<h1>Response headers were &gt; 8kb, which is not supported by Node.js</h1>'),
            headers: new Map([
              ['Content-Type', 'text/html']
            ])
          })
        } else {
          info.done(Promise.reject(rethrow(err)))
        }
      } else {
        info.done(res)
      }
    }
  }
}

function siteConfig (uri, conf) {
  if (!conf) conf = {}
  if (!conf.sites) conf.sites = {}
  const hostname = canonicalDomain(new URL(uri).hostname)
  const domain = hostname.split(/[.]/)
  while (domain.length > 0) {
    const host = domain.join('.')
    if (host in conf.sites) return conf.sites[host]
    domain.shift()
  }
  return conf.sites[hostname] = {}
}

function defaultConfig (conf) {
  return (conf && conf.sites && conf.sites.default) || {}
}

function siteLimits (uri, conf) {
  return siteConfig(uri, conf).limits || {}
}
function defaultLimits (uri, conf) {
  return defaultConfig(uri, conf).limits || {}
}

function setCookieP (jar, cookie, link) {
  const linkP = new URL(link)
  linkP.pathname = ''
  return new Promise((resolve, reject) => {
    jar.setCookie(cookie, url.format(linkP), (err, cookie) => {
      return err ? reject(rethrow(err)) : resolve(cookie)
    })
  })
}

function resToError (meta, toFetch) {
  if (!meta) return
  if (meta.status === 403) {
    const err = new Error('Got status: ' + meta.status + ' ' + meta.statusText + ' for ' + toFetch)
    Error.captureStackTrace(err, resToError)
    err.code = meta.status
    err.url = toFetch
    err.meta = meta
    return err
  } else if (meta.status === 429) {
    const err = new Error('Got status: ' + meta.status + ' ' + meta.statusText + ' for ' + toFetch)
    Error.captureStackTrace(err, resToError)
    err.code = meta.status
    err.url = toFetch
    err.meta = meta
    err.retryAfter = meta.headers['retry-after']
    return err
  } else if (meta.status === 404) {
    const err = new Error('Got status: ' + meta.status + ' ' + meta.statusText + ' for ' + toFetch)
    Error.captureStackTrace(err, resToError)
    err.code = meta.status
    err.url = toFetch
    err.meta = meta
    return err
  } else if (meta.status && (meta.status < 200 || meta.status >= 400)) {
    const err = new Error('Got status: ' + meta.status + ' ' + meta.statusText + ' for ' + toFetch)
    Error.captureStackTrace(err, resToError)
    err.code = meta.status
    err.url = toFetch
    err.meta = meta
    return err
  }
}
