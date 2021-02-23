importScripts("https://cdn.jsdelivr.net/npm/comlink");
self.languagePluginUrl = 'https://cdn.jsdelivr.net/pyodide/dev/full/pyodide.js';
importScripts('https://cdn.jsdelivr.net/pyodide/dev/full/pyodide.js');
let fetchPythonCode = fetch("code.py");

function sleep(t){
    return new Promise(resolve => setTimeout(resolve, t));
}
self.sleep = sleep;

function promiseHandles(){
    let result;
    let promise = new Promise((resolve, reject) => {
        result = {resolve, reject};
    });
    result.promise = promise;
    return result;
}

async function initializePyodide() {
    let mainPythonCode = await (await fetchPythonCode).text();
    let namespace = pyodide.pyimport("dict")();
    pyodide.pyodide_py.eval_code(mainPythonCode, namespace);
    for(let name of ["exec_code", "format_exception", "banner", "pycomplete"]){
        self[name] = namespace[name];        
    }
    namespace.destroy();
}

// Comlink proxy and PyProxy don't get along as of yet so need a wrapper
function complete(value){
    let proxy = pycomplete(value);
    let result = proxy.toJs();
    proxy.destroy();
    return result;
}

let decoder = new TextDecoder("utf-8");

class InnerStdinReader {
    constructor(stdin_reader){
        return (async () => {
            this.outer_reader = stdin_reader;
            [this._size, this._buffer] = await stdin_reader.buffers();
            return this;
        })();
    }

    _read(n){
        this.outer_reader._read(n);
        Atomics.wait(this._size, 0);
        let size = this._size[0];
        if(size === -1){
            throw new Error("Stdin Cancelled");
        }
        // Can't use subarray, "the provided ArrayBufferView value must not be shared."
        return decoder.decode(this._buffer.slice(0, size));
    }
}

class InnerExecution {
    constructor(code){
        this._code = code;
        this._interrupt_buffer = new Int32Array(new SharedArrayBuffer(4));
        this._validate_syntax = promiseHandles();
        this._result = promiseHandles();
        this._result.promise.finally(() => {
            for(let proxy of this.proxies){
                proxy[Comlink.releaseProxy]();
            }
        });
        this.proxies = [];
        this._stdin_callback = () => {throw new Error("No stdin callback registered!");};
        this._stdout_callback = () => {};
        this._stderr_callback = () => {};
    }

    interrupt_buffer(){
        return Comlink.transfer(this._interrupt_buffer);
    }

    start(){
        this._start_inner().then(this._result.resolve, this._result.reject);
    }

    async _start_inner(){
        pyodide.setInterruptBuffer(this._interrupt_buffer);
        try {
            return await exec_code(
                this._code, 
                this._validate_syntax.resolve, 
                this._stdin_callback,
                this._stdout_callback, 
                this._stderr_callback
            );
        } catch(e){
            this._validate_syntax.reject(pyodide.globals.repr(e.pythonError));
            let msg = format_exception(e.pythonError);
            throw new Error(msg);
        } finally {
            pyodide.setInterruptBuffer();
        }
    }
    
    async validate_syntax(){
        // this._result.promise.catch(()=>{});
        return await this._validate_syntax.promise;
    }

    async result(){
        return await this._result.promise;
    }

    async setStdin(outer_stdin_reader){
        this.proxies.push(outer_stdin_reader);
        this._stdinReader = await new InnerStdinReader(outer_stdin_reader);
        this._stdin_callback = this._stdinReader._read.bind(this._stdinReader);
    }

    onStdout(callback){
        this.proxies.push(callback);
        this._stdout_callback = (msg) => callback(msg);
    }

    onStderr(callback){
        this.proxies.push(callback);
        this._stderr_callback = (msg) => callback(msg);
    }
}


async function init(){
    await languagePluginLoader;
    await initializePyodide();
    return Comlink.proxy({ 
        InnerExecution, 
        pyodide,
        banner,
        complete
    });
}
Comlink.expose(init);
