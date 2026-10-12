"use strict";
// Preloaded with NODE_OPTIONS=--require=<this file> into every process of the offline end-to-end run. It refuses every
// connection, DNS lookup and fetch whose destination is not this machine, and appends one line per attempt to the file
// named by CR_DENY_LOG. The test then asserts that the file is empty: the deterministic core made no outbound attempt,
// and everything still worked while such attempts would have failed.
const fs = require("node:fs");
const net = require("node:net");
const dns = require("node:dns");

const log = process.env.CR_DENY_LOG;
const record = (kind, target) => {
  if (log) fs.appendFileSync(log, `${kind} ${target}\n`);
};
const isLocalName = (host) => {
  if (host === undefined || host === null || host === "") return true;
  const h = String(host).toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || h === "::" || h === "0.0.0.0" || /^127\.\d+\.\d+\.\d+$/.test(h) || h === "::ffff:127.0.0.1";
};

const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function connect(...args) {
  const [options] = net._normalizeArgs(args);
  if (!options.path && !isLocalName(options.host)) {
    record("connect", `${options.host}:${options.port}`);
    const error = Object.assign(new Error(`outbound connection denied: ${options.host}:${options.port}`), { code: "ECONNREFUSED" });
    process.nextTick(() => this.destroy(error));
    return this;
  }
  return originalConnect.apply(this, args);
};

const originalLookup = dns.lookup;
dns.lookup = function lookup(hostname, ...rest) {
  if (!isLocalName(hostname)) {
    record("dns", hostname);
    const callback = rest[rest.length - 1];
    const error = Object.assign(new Error(`outbound lookup denied: ${hostname}`), { code: "ENOTFOUND" });
    if (typeof callback === "function") return process.nextTick(callback, error);
  }
  return originalLookup.call(this, hostname, ...rest);
};
const originalPromisesLookup = dns.promises.lookup;
dns.promises.lookup = function lookup(hostname, ...rest) {
  if (!isLocalName(hostname)) {
    record("dns", hostname);
    return Promise.reject(Object.assign(new Error(`outbound lookup denied: ${hostname}`), { code: "ENOTFOUND" }));
  }
  return originalPromisesLookup.call(this, hostname, ...rest);
};

if (typeof globalThis.fetch === "function") {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = function fetch(input, init) {
    let host = "";
    try {
      host = new URL(typeof input === "string" || input instanceof URL ? input : input.url).hostname;
    } catch {
      host = "";
    }
    if (!isLocalName(host)) {
      record("fetch", host);
      return Promise.reject(new TypeError("outbound fetch denied: " + host));
    }
    return originalFetch.call(this, input, init);
  };
}
