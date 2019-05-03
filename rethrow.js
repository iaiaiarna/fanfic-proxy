'use strict'
module.exports = rethrow

const qw = require('qw')

function rethrow (err) {
  if (!err) return err
  const nerr = new Error(err.stack)
  Error.captureStackTrace(nerr, rethrow)
  for (let kk of qw`code name url meta`) {
    nerr[kk] = err[kk]
  }
  return err
}
