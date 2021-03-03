import * as Comlink from "https://unpkg.com/comlink/dist/esm/comlink.mjs";
let pyodide;
let InnerExecution;
let banner;
let complete;

function sleep(t){
    return new Promise(resolve => setTimeout(resolve, t));
}

function promiseHandles(){
    let result;
    let promise = new Promise((resolve, reject) => {
        result = {resolve, reject};
    });
    result.promise = promise;
    return result;
}

let { resolve : resolveInitialized, promise : initialized } = promiseHandles();

let buffers = {
    size_buffer : new Int32Array(new SharedArrayBuffer(8)),
    data_buffer : new Uint8Array(new SharedArrayBuffer(0)),
    data_buffer_promise : undefined
};

function set_data_buffer(buffer){
    buffers.data_buffer = buffer;
    buffers.data_buffer_promise.resolve();
}

let encoder = new TextEncoder("utf-8");
function blockingWrapperForAsync(func){
    async function wrapper(...args){
        try {
            let result;
            let err_sgn = 1;
            try {
                result = await func(...args);
            } catch(e){
                result = { name : e.name, message : e.message, stack : e.stack };
                err_sgn = -1;
            }
            let bytes = encoder.encode(JSON.stringify(result));
            let fits = bytes.length <= buffers.data_buffer.length;
            buffers.size_buffer[0] = bytes.length;
            buffers.size_buffer[1] = err_sgn * fits;
            if(!fits){
                buffers.data_buffer_promise = promiseHandles();
                await sleep(5);
                Atomics.notify(buffers.size_buffer, 1);
                await buffers.data_buffer_promise.promise;
            }
            buffers.size_buffer[1] = err_sgn;
            buffers.data_buffer.set(bytes);
            await sleep(5);
            Atomics.notify(buffers.size_buffer, 1);
        } catch(e){
            console.warn(`Error occurred in blockingWrapperForAsync for ${func.name}:`);
            console.warn(e);
        }
    }
    return Comlink.proxy(wrapper);
}

async function myFetch(arg){
    return await (await fetch(arg)).text();
}

async function testError(){
    function f(){
        throw new Error("oops!");
    }
    f();
}

const wrappers = {
    fetch : myFetch,
    testError : testError
};
for(let [k, v] of Object.entries(wrappers)){
    wrappers[k] = blockingWrapperForAsync(v);
}
wrappers.name_list = Object.getOwnPropertyNames(wrappers);


async function initializePyodide(){
    const worker = new Worker("pyodide-worker.js");
    const wrapper = Comlink.wrap(worker);
    const result = await wrapper(Comlink.transfer(buffers.size_buffer), Comlink.proxy(set_data_buffer), Comlink.proxy(wrappers));
    ({pyodide, InnerExecution, banner, complete} = result);
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
        await this._inner.setStdin(blockingWrapperForAsync(callback));
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
window.Execution = Execution;

export {Execution, pyodide, banner, complete, initializePyodide};