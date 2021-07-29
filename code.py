from js import blockingSleep
from pyodide.console import BANNER, PyodideConsole
from pyodide import JsException
import __main__
import time

__all__ = ["BANNER", "pycomplete", "exec_code"]

time.sleep = blockingSleep

pyconsole = PyodideConsole(globals=__main__.__dict__, filename="<console>")

def pycomplete(source):
    return pyconsole.complete(source)

async def exec_code(
    code, syntax_check_passed, stdin_callback, stdout_callback, stderr_callback
):
    pyconsole.stdin_callback = stdin_callback
    pyconsole.stdout_callback = stdout_callback
    pyconsole.stderr_callback = stderr_callback
    fut = pyconsole.runsource(code)
    if fut.syntax_check == "syntax-error":
        fut.result() # cause error to be raised
    syntax_check_passed()
    return await fut
