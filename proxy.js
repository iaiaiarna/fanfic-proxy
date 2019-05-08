'use strict'
const fs = require('fs')
const url = require('url')
const qr = require('@perl/qr')
const Koa = require('koa')
const cacache = require('cacache/en')
const plainFetch = require('node-fetch')
const fetchBackOff = require('./fetch-back-off.js')
const logger = require('koa-logger')
const http = require('http')
const HttpAgent = require('agentkeepalive')
const HttpsAgent = require('agentkeepalive').HttpsAgent
const fun = require('funstream')
const Gzip = require('minizlib').Gzip
const Gunzip = require('minizlib').Gunzip
const Handlebars = require('handlebars')
const moment = require('moment')

function makeCacache (cachedir) {
  return {
    verify: () => cacache.verify(cachedir),
    getInfo: key => cacache.get.info(cachedir, key),
    getStream: key => cacache.get.stream(cachedir, key),
    rmEntry: key => cacache.rm.entry(cachedir, key),
    putStream: (key, options) => cacache.put.stream(cachedir, key, options)
  }
}

module.exports = async userConf => {
  if (!userConf) userConf = {}
  if (!userConf.proxy) userConf.proxy = {}
  if (!userConf.agent) userConf.agent = {}
  const conf = {
    ...userConf,
    proxy: {
      port: 10700,
      cache: true,
      cachedir: `cache/`,
      requestlog: true,
      ...userConf.proxy
    },
    agent: {
      maxSockets: 60,
      strictSSL: true,
      ...userConf.agent
    }
  }

  if (!conf.agent.name) throw new Error('Must provide agent.name config value, how to identify your app to sites you scrape from')
  if (!conf.agent.version) throw new Error('Must provide agent.version config value, the version of your app')
  if (!conf.agent.homepage) throw new Error('Must provide agent.homepage config value, a page describing what your app does and how to contact you')

  conf.fetch = fetchBackOff(plainFetch, conf)
  conf.cache = conf.proxy.cache && makeCacache(conf.proxy.cachedir)

  const templateDir = conf.templatedir || __dirname
  /* eslint-disable security/detect-non-literal-fs-filename */
  const sbTemplate = Handlebars.compile(fs.readFileSync(`${templateDir}/proxy-scoreboard.html`, 'utf8'))

  conf.agent['http:'] = new HttpAgent({
    maxSockets: conf.agent.maxSockets,
    localAddress: conf.agent.outboundAddress
  })
  conf.agent['https:'] = new HttpsAgent({
    maxSockets: conf.agent.maxSockets,
    ca: conf.agent.ca,
    cert: conf.agent.cert,
    key: conf.agent.key,
    localAddress: conf.agent.outboundAddress,
    rejectUnauthorized: conf.agent.strictSSL
  })

  if (conf.proxy.cache && conf.verify) {
    console.log('verifying cache...')
    await conf.cache.verify()
  }

  console.log('firing up service')
  const proxy = new Koa()
  proxy.use(fixupHttps)
  if (conf.proxy.requestlog) proxy.use(logger())
  proxy.use(routeRequest)
  const proxySrv = http.createServer(proxy.callback()).listen(conf.proxy.port, () => console.error('listening'))

  await new Promise((resolve, reject) => {
    proxy.on('error', reject)
    proxySrv.on('error', reject)
    process.on('SIGINT', resolve)
  })
  proxySrv.close()

  async function fixupHttps (ctx, next) {
    const reqUrl = url.parse(ctx.url)
    if (reqUrl.protocol === 'https:' || reqUrl.port === 443) {
      reqUrl.protocol = 'https:'
      delete reqUrl.port
      reqUrl.host = reqUrl.hostname
      ctx.url = url.format(reqUrl)
    }
    if (/^[/]https?:/.test(reqUrl.path)) {
      ctx.url = reqUrl.path.slice(1)
    }
    return next()
  }

  async function routeRequest (ctx, next) {
    try {
      if (ctx.url === '/') {
        const accepts = ctx.accepts('html', 'json')
        if (accepts === 'json') {
          ctx.status = 200
          ctx.body = scoreBoard()
        } else {
          ctx.status = 200
          ctx.body = sbTemplate(scoreBoard())
        }
        return next()
      } else if (qr`^https?://`.test(ctx.url)) {
        ctx.body = fun()
          .on('error', err => {
            ctx.throw(500, err.message)
          })
        const hasCache = conf.proxy.cache
        const onlyIfCached = ctx.header['cache-control'].toLowerCase() === 'only-if-cached'
        const preferCached = ctx.header['cache-control'].toLowerCase() === 'prefer-cached'
        if (hasCache && (onlyIfCached || preferCached)) {
          try {
            return await fromCache(ctx, conf, next)
          } catch (_) {
            // ignored because we'll just try the network instead
          }
        }
        // TODO: Allow more typical cache behavior, eg check cache freshness, look up last modified times for
        // if-modified-since checking, etc. Low priority, however, given the core usecase of this module.
        if (onlyIfCached) {
          ctx.throw(504, 'Not in cache')
          return
        }
        return await fromNetwork(ctx, conf, next)
      }
    } catch (err) {
      console.error('fromRequest error', err)
      ctx.throw(500, 'errored')
    }
  }
}

async function fromCache (ctx, conf, next) {
  const {metadata} = await conf.cache.getInfo(ctx.url)
  let errored = false
  const cacheResult = fun(conf.cache.getStream(ctx.url))
    .pipe(new Gunzip())
    .once('error', async err => {
      if (errored) {
        if (errored !== err.message) console.error(err.message)
        return
      }
      errored = err.message
      await conf.cache.rmEntry(ctx.url).catch(_ => {})
      fromNetwork(ctx, conf, next)
    })
    .on('data', async function onData (data) {
      cacheResult.removeListener('data', onData)
      const status = metadata.status
      if (status === 429) {
        await conf.cache.rmEntry(ctx.url).catch(_ => {})
        return fromNetwork(ctx, conf, next)
      }
      if (status) ctx.status = status
      const headers = metadata.headers ? metadata.headers : metadata
      for (let header of Object.entries(headers)) {
        const [key, value] = header
        ctx.set(key, value)
      }
      ctx.body.write(data)
      cacheResult.pipe(ctx.body)
      next()
    })
}

async function fromNetwork (ctx, conf, next) {
  const userAgent = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10.13; rv:59.0; ${conf.agent.name}/${conf.agent.version}; +${conf.agent.homepage}) Gecko/20100101 Firefox/59.0`
  const reqUrl = url.parse(ctx.url)
  const agent = conf.agent[reqUrl.protocol]
  const reqHeaders = {}
  reqHeaders['User-Agent'] = userAgent
  if (ctx.header.accept) reqHeaders['Accept'] = ctx.header.accept
  if (ctx.header['accept-encoding']) reqHeaders['Accept-Encoding'] = ctx.header['accept-encoding']
  if (ctx.header['content-type']) reqHeaders['Content-Type'] = ctx.header['content-type']
  if (ctx.header['content-length']) reqHeaders['Content-Length'] = ctx.header['content-length']
  const opts = {
    headers: reqHeaders,
    method: ctx.method,
    agent,
    body: (ctx.method === 'POST' || ctx.method === 'PUT') ? ctx.req : undefined,
    redirect: 'manual'
  }
  if (opts.body) opts.body.on('error', err => ctx.throw(500, err.message))
  try {
    const response = await conf.fetch(ctx.url, opts)
    ctx.status = response.status
    const body = response.body
    const headers = {}
    for (let header of response.headers.entries()) {
      const [key, value] = header
      if (key === 'transfer-encoding' || key === 'content-encoding' || key === 'content-length' || key === 'connection') continue
      headers[key] = value
      ctx.set(key, value)
    }
    ctx.set('FF-Final-URL', response.finalUrl || ctx.url)
    body.pipe(ctx.body)
      .on('error', err => console.error('body->response error', err))

    if (conf.proxy.cache) {
      // errors from cache storage are ignored because things work anyway
      body.pipe(new Gzip())
        .on('error', err => console.error('body->gzip error', err))
        .pipe(conf.cache.putStream(ctx.url, {metadata: {status: response.status, headers}}))
        .on('error', err => console.error('gzip->cache error', err))
    }
    next()
  } catch (err) {
    ctx.status = 500
    console.error('fromNetwork error', err)
    return next()
  }
}

function formatDate (date) {
  if (!date) return '-'
  return moment(date).toString()
}

function scoreBoard () {
  const state = fetchBackOff.state
  const sb = {
    inflightCount: Object.keys(state.inflight).length,
    queued: state.enqueued,
    flying: state.flying,
    nextReq: formatDate(state.nextReq),
    lastReq: formatDate(state.lastReq),
    lastComplete: formatDate(state.lastComplete),
    hosts: []
  }
  for (let host of Object.values(state.hosts)) {
    sb.hosts.push({
      name: host.name,
      queued: host.queue.length,
      flying: host.flying,
      nextReq: formatDate(host.nextReq),
      lastReq: formatDate(host.lastReq),
      lastComplete: formatDate(host.lastComplete),
      lastErr: host.lastErr || ''
    })
  }
  return sb
}
