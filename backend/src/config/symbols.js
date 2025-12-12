"use strict";

// Mirrors frontend mappings (js/websocket.js + js/websocket-orderbook.js) where possible.
const SYMBOL_MAPS = {
  kraken: {
    BTC: "XBT/USD",
    ETH: "ETH/USD",
    SOL: "SOL/USD",
    XRP: "XRP/USD",
    DOGE: "DOGE/USD",
    ADA: "ADA/USD",
    AVAX: "AVAX/USD",
    DOT: "DOT/USD",
    LINK: "LINK/USD",
    LTC: "LTC/USD",
    MATIC: "MATIC/USD",
    UNI: "UNI/USD",
    ATOM: "ATOM/USD",
    FIL: "FIL/USD",
    APT: "APT/USD",
    ARB: "ARB/USD",
    OP: "OP/USD",
    NEAR: "NEAR/USD",
    SHIB: "SHIB/USD",
    BCH: "BCH/USD",
    SUI: "SUI/USD",
  },
  coinbase: {
    BTC: "BTC-USD",
    ETH: "ETH-USD",
    SOL: "SOL-USD",
    XRP: "XRP-USD",
    DOGE: "DOGE-USD",
    ADA: "ADA-USD",
    AVAX: "AVAX-USD",
    DOT: "DOT-USD",
    LINK: "LINK-USD",
    LTC: "LTC-USD",
    MATIC: "MATIC-USD",
    UNI: "UNI-USD",
    ATOM: "ATOM-USD",
    FIL: "FIL-USD",
    APT: "APT-USD",
    ARB: "ARB-USD",
    OP: "OP-USD",
    NEAR: "NEAR-USD",
    SHIB: "SHIB-USD",
    BCH: "BCH-USD",
    SUI: "SUI-USD",
  },
  bitstamp: {
    BTC: "btcusd",
    ETH: "ethusd",
    SOL: "solusd",
    XRP: "xrpusd",
    DOGE: "dogeusd",
    ADA: "adausd",
    AVAX: "avaxusd",
    DOT: "dotusd",
    LINK: "linkusd",
    LTC: "ltcusd",
    MATIC: "maticusd",
    UNI: "uniusd",
    ATOM: "atomusd",
    FIL: "filusd",
    APT: "aptusd",
    ARB: "arbusd",
    OP: "opusd",
    NEAR: "nearusd",
    SHIB: "shibusd",
    BCH: "bchusd",
    SUI: "suiusd",
  },
};

function getExchangeSymbol(exchange, symbol) {
  const sym = String(symbol || "").toUpperCase();
  const map = SYMBOL_MAPS[exchange];
  return map ? map[sym] || null : null;
}

module.exports = { SYMBOL_MAPS, getExchangeSymbol };
