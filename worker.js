let mainPythonCode = `
from pyodide._base import CodeRunner
from contextlib import redirect_stdout, redirect_stderr, contextmanager, _RedirectStream
from asyncio import iscoroutine
from pyodide.console import repr_shorten, InteractiveConsole
from js import console, sleep
import __main__
import ast
class WriteStream:
    """A utility class so we can specify our own handlers for writes to sdout, stderr"""
    def __init__(self, write_handler):
        self.write_handler = write_handler
    
    def write(self, text):
        self.write_handler(text)

class ReadStream:
    def __init__(self, read_handler):
        self.read_handler = read_handler

    def readline(self, n = -1):
        result = self.read_handler()
        print(result)
        return result

class redirect_stdin(_RedirectStream):
    _stream = "stdin"

banner = InteractiveConsole.banner(None)

import re
import rlcompleter
match_nonwhite_space = re.compile("[^\\w\\d\\s.(]")
completer = rlcompleter.Completer(__main__.__dict__)
def pycomplete(source):
    revsource = source[::-1]
    match = match_nonwhite_space.search(revsource)
    if match:
        source = source[:-match.end()]
    console.log("source", source)
    completer.complete(source, 0)
    return completer.matches
    
code_runner = CodeRunner(globals=__main__.__dict__, filename="<console>")
async def exec_code(code, syntax_check_passed, stdin_callback, stdout_callback, stderr_callback):
    try:
        mod, last_expr = code_runner._split_and_compile(
            code, flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT  # type: ignore
        )
        syntax_check_passed()
        await sleep(0);
        with redirect_stdout(WriteStream(stdout_callback)),\
        redirect_stderr(WriteStream(stderr_callback)),\
        redirect_stdin(ReadStream(stdin_callback)):
            # run first part
            if mod is not None:
                coro = eval(mod, code_runner.globals, code_runner.locals)
                if iscoroutine(coro):
                    await coro

            # evaluate last expression
            if last_expr is not None:
                res = eval(last_expr, code_runner.globals, code_runner.locals)
                if iscoroutine(res):
                    res = await res
                if res is not None:
                    res = repr_shorten(res)
                return res
    except Exception as e:
        print(e)
        raise e
def format_exception(err):
    import traceback
    nframes = 0
    keptframes = 0
    for (frame, _) in traceback.walk_tb(err.__traceback__):
        if frame.f_code.co_name == "exec_code":
            keptframes = 0
        else:
            keptframes += 1
    return "".join(traceback.format_exception(type(err), err, err.__traceback__, -keptframes))
`

importScripts("https://unpkg.com/comlink/dist/umd/comlink.js");
self.languagePluginUrl = 'https://pyodide-cdn2.iodide.io/dev/full/pyodide.js'
importScripts(`https://pyodide-cdn2.iodide.io/dev/full/pyodide.js`);

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

function initializePyodide() {
    // let namespace = pyodide.pyimport("dict")();
    let namespace = pyodide.globals;
    pyodide.pyodide_py.eval_code(mainPythonCode, namespace);
    for(let name of ["exec_code", "format_exception", "banner", "pycomplete"]){
        self[name] = namespace[name];        
    }
    // namespace.destroy();
}

function complete(value){
    return pycomplete(value).toJs();
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
            console.log(e);
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
        if(this._stdinReader){
            return this._stdinReader;
        }
        this._stdinReader = await new InnerStdinReader(outer_stdin_reader);
        this._stdin_callback = this._stdinReader._read.bind(this._stdinReader);
    }

    onStdout(callback){
        this._stdout_callback = (msg) => callback(msg);
    }

    onStderr(callback){
        this._stderr_callback = (msg) => callback(msg);
    }
}

class Test {
    constructor(code){
        this._buffer = new Int32Array(new SharedArrayBuffer(4));
    }

    buffer(){
        return Comlink.transfer(this._buffer);
    }

    get_value(){
        Atomics.wait(this._buffer, 0);
    }
}

async function init(){
    await languagePluginLoader;
    initializePyodide();
    return Comlink.proxy({ 
        InnerExecution, 
        pyodide,
        Test,
        banner,
        complete
    });
}
Comlink.expose(init);
