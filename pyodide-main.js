import * as Synclink from "https://unpkg.com/synclink@0.1.0/dist/esm/synclink.mjs";

window.Synclink = Synclink;
let pyodide;
let InnerExecution;
let BANNER;
let complete;

function sleep(t) {
  return new Promise((resolve) => setTimeout(resolve, t));
}

function promiseHandles() {
  let result;
  let promise = new Promise((resolve, reject) => {
    result = { resolve, reject };
  });
  result.promise = promise;
  return result;
}

let { resolve: resolveInitialized, promise: initialized } = promiseHandles();

async function initializePyodide() {
  const worker = new Worker("pyodide-worker.js");
  const wrapper = Synclink.wrap(worker);
  const result = await wrapper(Synclink.proxy(window));
  ({ pyodide, InnerExecution, BANNER, complete } = result);
  wrapper[Synclink.releaseProxy]();
  BANNER = "Welcome to the Pyodide terminal emulator 🐍\n" + (await BANNER);
  window.pyodide = pyodide;
  resolveInitialized();
}

Synclink.transferHandlers.set("EVENT", {
  canHandle: (obj) => obj instanceof Event,
  serialize: (ev) => {
    return [
      {
        target: {
          id: ev.target.id,
          classList: [...ev.target.classList],
          clientX: ev.clientX,
          clientY: ev.clientY,
        },
      },
      [],
    ];
  },
  deserialize: (obj) => obj,
});

class Execution {
  constructor(code) {
    return (async () => {
      await initialized;
      this._inner = await new InnerExecution(code);
      this._result = this._inner.result();
      this._validate_syntax = this._inner.validate_syntax();
      this._interrupt_buffer = await this._inner.interrupt_buffer();
      this._started = false;
      return this;
    })();
  }

  start() {
    this._started = true;
    this._inner.start().schedule_async();
  }

  keyboardInterrupt() {
    this._interrupt_buffer[0] = 2;
  }

  validate_syntax() {
    return this._validate_syntax;
  }

  result() {
    return this._result;
  }

  async onStdin(callback) {
    if (this._started) {
      throw new Error(
        "Cannot set standard in callback after starting the execution."
      );
    }
    await this._inner.setStdin(Synclink.proxy(callback));
  }

  async onStdout(callback) {
    if (this._started) {
      throw new Error(
        "Cannot set standard out callback after starting the execution."
      );
    }
    await this._inner.onStdout(Synclink.proxy(callback));
  }

  async onStderr(callback) {
    if (this._started) {
      throw new Error(
        "Cannot set standard error callback after starting the execution."
      );
    }
    await this._inner.onStderr(Synclink.proxy(callback));
  }
}
window.Execution = Execution;

export { Execution, pyodide, BANNER, complete, initializePyodide };
