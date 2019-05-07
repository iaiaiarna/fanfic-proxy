#!/usr/bin/env node
'use strict'
const proxy = require('./proxy.js')

process.setMaxListeners(50)

const promisify = require('util').promisify
/* eslint-disable security/detect-non-literal-fs-filename */
const readFile = promisify(require('fs').readFile)
const TOML = require('@iarna/toml')
require('@iarna/cli')(main)
  .usage('$0 [options] <conf>')
  .boolean('verify')
  .describe('verify', 'Verify and clean the cache')
  .default('verify', true)
  .demand(1)
  .strict()
  .version()
  .help()

async function main (opts, confFile) {
  console.error('starting...')
  const conf = {
    ...TOML.parse(await readFile(confFile)),
    verify: opts.verify
  }
  return Promise.all([
    proxy(conf)
  ])
}
