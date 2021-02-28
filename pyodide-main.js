import * as Comlink from "https://unpkg.com/comlink/dist/esm/comlink.mjs";
let pyodide;
let InnerExecution;
let banner;
let complete;

let resolveInitialized;
let initialized = new Promise(resolve => resolveInitialized = resolve);
async function initializePyodide(){
    const worker = new Worker("pyodide-worker.js");
    const wrapper = Comlink.wrap(worker);
    ({pyodide, InnerExecution, banner, complete} = await wrapper());
    wrapper[Comlink.releaseProxy]();
    banner = "Welcome to the Pyodide terminal emulator 🐍\n" + await banner;
    window.pyodide = pyodide;
    resolveInitialized();
}


class Execution {
    constructor(code){
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

    start(){
        this._started = true;
        this._inner.start();
    }

    keyboardInterrupt(){
        this._interrupt_buffer[0] = 2;
    }
    
    validate_syntax(){
        return this._validate_syntax;
    }

    result(){
        return this._result;
    }

    async onStdin(callback){
        if(this._started){
            throw new Error("Cannot set standard in callback after starting the execution.");
        }
        await this._inner.setStdin(Comlink.proxy(new StdinReader(callback)));
    }

    async onStdout(callback){
        if(this._started){
            throw new Error("Cannot set standard out callback after starting the execution.");
        }
        await this._inner.onStdout(Comlink.proxy(callback));
    }

    async onStderr(callback){
        if(this._started){
            throw new Error("Cannot set standard error callback after starting the execution.");
        }
        await this._inner.onStderr(Comlink.proxy(callback));
    }
}

let encoder = new TextEncoder("utf-8");
class StdinReader {
    constructor(readCallback){
        this._readCallback = readCallback;
        this._size = new Int32Array(new SharedArrayBuffer(8));
        this._buffer = new Uint8Array(new SharedArrayBuffer(1000));
    }

    buffers(){
        return [Comlink.transfer(this._size), Comlink.transfer(this._buffer)];
    }

    async _read(n){
        try {
            let text = await this._readCallback(n);
            console.log("text", `$${text}$`);
            // encodeInto apparently doesn't work with SAB...
            let bytes = encoder.encode(text);
            this._size[0] = bytes.length;
            this._buffer.set(bytes);
            Atomics.notify(this._size, 0);
        } catch(e){
            this._size[0] = -1;
            Atomics.notify(this._size, 0);
        }
    }
}

export {Execution, pyodide, banner, complete, initializePyodide};