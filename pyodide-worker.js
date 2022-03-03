importScripts("https://cdn.jsdelivr.net/npm/synclink");
let indexURL = "https://cdn.jsdelivr.net/pyodide/v0.19.1/full/";
importScripts(indexURL + "pyodide.js");
let pyodideLoaded = loadPyodide({ indexURL });

async function fetch_and_install(url) {
  const fetch_promise = fetch(url).then(
    async (resp) => new Uint8Array(await resp.arrayBuffer())
  );
  await pyodideLoaded;
  const buffer = await fetch_promise;
  const name = url.substring(url.lastIndexOf("/") + 1);
  const stream = pyodide.FS.open(name, "w+");
  pyodide.FS.write(stream, buffer, 0, buffer.byteLength, 0, true);
  pyodide.FS.close(stream);
}
const pycode_promise = fetch_and_install("console_main.py");

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

// Synclink proxy and PyProxy don't get along as of yet so need a wrapper
function complete(value) {
  let proxy = pycomplete(value);
  let result = proxy.toJs();
  proxy.destroy();
  return result;
}

async function callProxy(px, ...rest) {
  return await px(...rest);
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

class InnerExecution {
  constructor(code) {
    this._code = code;
    this._interrupt_buffer = new Int32Array(new SharedArrayBuffer(4));
    this._validate_syntax = promiseHandles();
    this._result = promiseHandles();
    this._result.promise.finally(() => {
      for (let proxy of this.proxies) {
        proxy[Synclink.releaseProxy]();
      }
    });
    this.proxies = [];
    this._stdin_callback = () => {
      throw new Error("No stdin callback registered!");
    };
    this._stdout_callback = () => {};
    this._stderr_callback = () => {};
  }

  interrupt_buffer() {
    return Synclink.transfer(this._interrupt_buffer);
  }

  start() {
    this._start_inner().then(this._result.resolve, this._result.reject);
  }

  async _start_inner() {
    pyodide.setInterruptBuffer(this._interrupt_buffer);
    let fut = exec_code(
      this._code,
      this._validate_syntax.resolve,
      this._stdin_callback,
      this._stdout_callback,
      this._stderr_callback
    );
    try {
      let [status, value] = await fut;
      if (status) {
        // It was an error
        let err = new Error(value);
        this._validate_syntax.reject(err);
        throw err;
      }
      return value;
    } finally {
      fut.destroy();
      pyodide.setInterruptBuffer();
    }
  }

  async validate_syntax() {
    // this._result.promise.catch(()=>{});
    return await this._validate_syntax.promise;
  }

  async result() {
    return await this._result.promise;
  }

  async setStdin(outer_stdin_reader) {
    this.proxies.push(outer_stdin_reader);
    this._stdin_callback = () => {
      return outer_stdin_reader().syncify();
    };
  }

  onStdout(callback) {
    this.proxies.push(callback);
    this._stdout_callback = (msg) => callback(msg).syncify();
  }

  onStderr(callback) {
    this.proxies.push(callback);
    this._stderr_callback = (msg) => callback(msg).syncify();
  }
}

let async_wrappers = {};
async function init(windowProxy) {
  self.pyodide = await pyodideLoaded;
  pyodide.registerComlink(Synclink);
  self.windowProxy = windowProxy;

  pyodide.registerJsModule("async_wrappers", async_wrappers);
  await pycode_promise;
  const console_main = pyodide.pyimport("console_main");
  for (let name of ["exec_code", "BANNER", "pycomplete"]) {
    self[name] = console_main[name];
  }
  return Synclink.proxy({
    InnerExecution,
    pyodide,
    BANNER,
    complete,
  });
}
Synclink.expose(init);
