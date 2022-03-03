from pyodide.console import BANNER, PyodideConsole, repr_shorten
from pyodide import to_js
import __main__
import time

__all__ = ["BANNER", "pycomplete", "exec_code"]

pyconsole = PyodideConsole(globals=__main__.__dict__, filename="<console>")


def pycomplete(source):
    return pyconsole.complete(source)


async def exec_code(
    code : str, syntax_check_passed, stdin_callback, stdout_callback, stderr_callback
):
    pyconsole.stdin_callback = stdin_callback
    pyconsole.stdout_callback = stdout_callback
    pyconsole.stderr_callback = stderr_callback
    for line in code.splitlines():
        fut = pyconsole.push(line)
        if fut.syntax_check == "syntax-error":
            return to_js([-1, fut.formatted_error])
    syntax_check_passed()
    try:
        result = await fut
        repr_result = repr_shorten(result) if result is not None else None
        return to_js([0, repr_result])
    except Exception:
        return to_js([-1, fut.formatted_error])
