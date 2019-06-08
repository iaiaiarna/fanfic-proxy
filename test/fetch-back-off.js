'use strict'
const test = require('tap').test
const fun = require('funstream')
const fbo = require('../fetch-back-off.js')

const ms = () => Number(new Date())

test('ex', async t => {
  let rounds = 0
  let last
  const fetch = fbo(async (url, opts) => {
    if (last) {
      console.log('Request:', url, ms() - last)
    } else {
      console.log('Request:', url)
    }
    last = ms()
    return {
      status: (++rounds<=1) ? 429 : 200,
      headers: new Map(),
      body: fun([1,2,3])
    }
  })
  process.on('warn', console.error)
  
  const result = await fetch('http://example.com')
  console.log(result)
})
