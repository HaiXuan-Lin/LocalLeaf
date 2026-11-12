"use strict";
const fs = require("node:fs");
const Path = require("node:path");

/** A small JSON file with an in-memory copy; writes are atomic. */
class JsonStore {
  constructor(filePath, defaults = {}) {
    this.filePath = filePath;
    this.data = { ...defaults };
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (parsed && typeof parsed === "object") {
        this.data = { ...defaults, ...parsed };
      }
    } catch {
      // missing or unreadable: start from the defaults
    }
  }

  get(key) {
    return this.data[key];
  }

  set(key, value) {
    this.data[key] = value;
    this.save();
  }

  update(values) {
    Object.assign(this.data, values);
    this.save();
  }

  save() {
    try {
      fs.mkdirSync(Path.dirname(this.filePath), { recursive: true });
      const tmpPath = `${this.filePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmpPath, this.filePath);
    } catch (error) {
      console.error(`could not save ${this.filePath}:`, error.message);
    }
  }
}

module.exports = { JsonStore };
