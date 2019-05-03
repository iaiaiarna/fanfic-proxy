# @fanfic/proxy

This is a pretty basic HTTP proxy, of a sort. 

# FEATURES

* Rate limiting: System-wide and per domain
* Concurrency limiting: System-wide and per domain
* Per domain cookie injection
* Retries with back off on timeouts, errors.
* Compliant retries of 429s
* Detailed visibility into status via an HTTP scoreboard (HTML and JSON).
* Ability to force requests to come from a cache, for working with a snapshot.

# LIMITATIONS

* The cache does not follow HTTP cache semantics.  All responses are stored
  in the cache.  Requests get the fresh version unless they explicitly
  request the cached version.  Cache headers from the response are currently
  ignored.
* While it can be used as a standard proxy for HTTP requests, use with
  HTTPS either requires the requestor send `GET https://...` type queries
  (instead of `CONNECT`), or that it use a non-standard request format
  (`GET /https://...`).  

# USAGE

```console
$ npx @fanfic/proxy config.toml
```

Alternatively, install it and run it:

```console
$ npm i @fanfic/proxy
$ npx proxy config.toml
```

Or use it as a library:

```
const startProxy = require('@fanfic/proxy')
const config = { ... }
startProxy(config).then(() => {
  console.log('Proxy closed.')
}).catch(err => {
  console.error('Proxy errored:', err)
})
```

# WHY THE NAME?

Ok, so it's not particularly fanfiction specific, but if you're scraping
fanfic, needing to keep under site "you're spidering us too hard" thresholds
is super important, and this is a tool specifically built to do that.

Also, the ability to inject auth is super super useful--many sites put
content behind auth-walls and this makes spidering it much easier, not
requring that knowledge to live in your spider.

Could this be done with a real proper http proxy? Sure, but setting this up
is distinctly simpler.

Also the ability to force use of the cache is helpful in development
when you may need to rerequest the same page 50 times.

# USING THE PROXY

Using the proxy is as easy as sticking the URL you want on the end of the
URL for the proxy server.

```javascript
const fetch = require('node-fetch')
const proxyServer = 'http://localhost:10700'
const link = 'https://example.com'
fetch(`${proxyServer}/${link}`, opts)
```

## REQUESTING FROM CACHE

```javascript
// To fetch ONLY from the cache (and 504 if not in the cache):
fetch(`${proxyServer}/${link}`, {headers: {cache-control: 'only-if-cached'}})

// To fetch from the cache if available (but hit the network if not):
fetch(`${proxyServer}/${link}`, {headers: {cache-control: 'prefer-cached'}})
```

## ALL TOGETHER

So for example, to get a fetch that will send all requests to the proxy
server and prefer cached versions:

```javascript
const nodeFetch = require('node-fetch')
const proxyServer = 'http://localhost:10700'
const fetch = (link, opts = {}) =>
  nodeFetch(`${proxyServer}/${link}`, {'cache-control': 'prefer-cached', ...opts})
```

# VIEWING THE STATUS

If the proxy was running on port 10700 then visit `http://localhost:10700/`
and you'll get summary of the current status of the proxy.

# EXAMPLE CONFIG

```toml
[agent]
name = "ExampleProxy"
version = "1"
homepage = "https://example.com"

[proxy]
port = 10700
requestlog = true
cache = true
cachedir = 'cache/'

[global.limits]
per-second = 120
concurrent = 60

[sites.default]
limits = { per-second = 8, concurrent = 4, retries = 5 }

[sites."very-limited.example.com"]
limits = { per-second = 1, concurrent = 2 }

[sites."needs-authentication.example.com"]
cookies = [
  "auth_cookie=abc-def-ghi-jkl-ghi-123-456-789"
]

```

# CONFIG

## templatedir = <string>

Place to look for the scoreboard template file `proxy-scoreboard.html`. 
Defaults to the one bundled with the module.

## verify = <boolean>

Default: true. If true and caching is enabled, the cache will be verified and stale entries removed at startup time. With a large cache this may make a goodly number of seconds.

## agent = <object>

Configures how the proxy represents itself to the world.

### agent.name

Required. The name of your proxy, will show up in the user-agent.

### agent.version

Required. The version of your proxy, will show up in the user agent

### agent.homepage

Required. This should be a web page describing what you're doing and how to contact you if your spidering is causing problems for a site. This shows up in the user agent.

### agent.maxSockets

Default: 60.  This needs to be >= the global concurrent limit.  This is
per-protocol so it would allow 60 http and 60 https sockets.

### agent.outboundAddress

## proxy = <object>

General configuration about the service itself

### proxy.port = <number>

Default: 10700. The port for the proxy to listen on.

### proxy.requestlog = <boolean>

Default: true. Print a request log to STDOUT.

### proxy.cache = <boolean>

Default: true. Record requests to a cache.

### proxy.cachedir = <string>

Default: 'cache/'.  The directory to cache requests in.  Defaults to cache/
under the current location.

## global = <object>

Stores global request limits that are computed across ALL requests
regardless of domain

### global.limits = {per-second, concurrent, minimum-gap}

Limits across all sites, combined.  Used to protect you and your network
network, not the site being scraped.

### global.limits.per-second = <number>

Default: Infinity. Maximum number of requests per second to make.

### global.limits.concurrent = <number>

Default: Infinity. Maximum number of current requests allowed at a time.

### global.limits.minimum-gap = <number>

Default: 0. Minimum time that must elapse between a request completing and a new request being made.

## sites = <object>

This is a map of domain names to objects configuring requests to that
domain.

### DEFAULT SITE

There is a special site named `default` which is used to set default limits.

### SITE PROPERTIES

#### site.cookies = []

This is an array of cookies to be sent to a site, it should look like:

```
  "cookie_name=cookie-value"
```

You can restrict cookies to only part of the site by adding a `Path` component:

```
  "cookie_name=cookie-value; Path=/example/"
```

#### site.limits = {per-second, concurrent, minimum-gap, retries}

Site limits are like global limits

#### site.limits.per-second = <number>

Default: 8. Maximum number of requests per second to make.

#### site.limits.concurrent = <number>

Default: 4. Maximum number of current requests allowed at a time.

#### site.limits.minimum-gap = <number>

Default: 0.  Minimum time that must elapse between a request completing and
a new request being made.

#### site.limits.retries = <number>

Default: 5.  Maximum number of times to retry a failing request.  Requests
can fail due to timeouts, server errors, or explit requests to query more
slowly (eg, the server sending a 429).

#### site.limits.timeout = <number>

Default: 15. Seconds in which a request must complete. 

# RETRY DELAYS

When a retry is needed, the retry is delayed for an amount of time computed
based on this formula:

```
1.5 + (0.5 * (tries ** 2))
```

This exponential backoff means that if the server is overloaded we'll give
it more and more space to get things together before trying again.

The first retry will sleep 2 seconds before trying again and the 5th will
sleep 14 seconds.  This also means that if you were to bump the number of
retries out to 10, it would be sleeping 51.5 seconds before making that
final request.

# LIMITS

So we have three sorts of limits: concurrent, per-second and minimum-gap.

The reason for this is because of the different ways different servers
determine what constitutes too much load.  The idea is to tune these to
match with how the server you're talking to defines its limits.

## concurrent

Web browsers set this limit as between 4 and 8, so if you're in that range
most sites won't get mad at you.  However, it's worth noting that real world
use means that most users have a single main page request, and the rest are
static content--scripts and images, which are lower resource consumption for
most services.  Servers that do implement connection limits usually do not
do it in terms of concurrency.

## per-second

This is the maximum number of requests per second to make.  This is based on
when the request was started, so you may end up with more concurrent
requests than you allow per second, because some of them were started
earlier. This is the most common restriction on requests.

## minimum-gap

The minimum number of seconds between completed requests.  This is useful
when your requests take a long time to process--it ensures that the target
server gets some breathing room between your requests.

# TODO

Tests.  Some tests would be nice.  This is also the kind of project that's
the most painful to test.  Thus the lack of them.  I make practical use of
it quite a lot, however.

This pretty much does everything I need it to do, but I would welcome
patches that add the following:

* Proper HTTP cache support--using cache control headers from the servers
  and submitting requests with etags and if-modified-since.
* A little client library wrapper.
