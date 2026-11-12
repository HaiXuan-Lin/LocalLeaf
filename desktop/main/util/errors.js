"use strict";

/** An error that maps onto an HTTP response of the local API. */
class HttpError extends Error {
  constructor(status, message, body) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.body = body;
  }
}

module.exports = { HttpError };
