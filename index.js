import {
  Execution,
  initializePyodide,
  pyodide,
  BANNER,
  complete,
} from "./pyodide-main.js";

let term;
export { term, pyodide, init };

function sleep(t) {
  return new Promise((resolve) => setTimeout(resolve, t));
}

function countLines(str) {
  return (str.match(/\n/g) || "").length + 1;
}

function getCurrentInputLine() {
  return term.get_command().split("\n")[countLines(term.before_cursor()) - 1];
}

function setCurrentInputLine(value) {
  let lines = term.get_command().split("\n");
  lines[countLines(term.before_cursor()) - 1] = value;
  term.set_command(lines.join("\n"));
}

function unindentCurrentLine() {
  let curLine = getCurrentInputLine();
  let trimmedLine = curLine.trimStart();
  let leadingSpaces = curLine.length - trimmedLine.length;
  setCurrentInputLine(
    " ".repeat(4 * (((leadingSpaces - 1) / 4) | 0)) + trimmedLine
  );
}

function scrollToBottom() {
  let contentBottom = document
    .querySelector(".cmd-wrapper")
    .getBoundingClientRect().bottom;
  let contentTop = document.body.getBoundingClientRect().top;
  let scroll = contentBottom - contentTop - window.innerHeight * 0.8;
  if (scroll + contentTop > 0) {
    window.scrollTo(0, scroll);
  }
}

function process_stream_write(s) {
  let newline = s.endsWith("\n");
  if (newline) {
    s = s.slice(0, -1);
  }
  return [s, newline];
}

const termState = {
  current_execution: undefined,
  reading_stdin: false,
  revsearch_active: false,
  revsearch_recently_active: false,
  revsearch_before_command: undefined,
};

const ps1 = ">>> ",
  ps2 = "... "; /* "\u2219\u2219\u2219" */

const promptMargin = document.querySelector(".console-prompt-margin");
const consoleWrapper = document.querySelector(".console-wrapper");

async function init() {
  await initializePyodide();
  // termOptions.greetings = banner;
  // Banner is produced from Python so it doesn't get populated until "ready".
  term = $(consoleWrapper.querySelector(".terminal")).terminal((command) => {},
  termOptions);
  term.echo(BANNER, { formatters: false });
  $.terminal.defaults.formatters.push($.terminal.prism.bind(null, "python"));
  // We have to put in "ENTER" here because of the newline bug
  term.keymap("ENTER", enterHandler);
  updatePrompts();
  inputObserver.observe(consoleWrapper.querySelector(".cmd-wrapper"), {
    childList: true,
  });
  cmdPromptObserver.observe(consoleWrapper.querySelector(".cmd-prompt"), {
    childList: true,
  });
}

function addPromptOnLevelWith(node, text) {
  let top = node.getBoundingClientRect().top;
  let span = document.createElement("span");
  let term_top = consoleWrapper.getBoundingClientRect().top;
  span.style.top = `${top - term_top}px`;
  span.style.position = "absolute";
  span.innerText = text;
  span.className = "input";
  promptMargin.appendChild(span);
}

function clearPrompts() {
  for (let node of promptMargin.querySelectorAll(".input")) {
    node.remove();
  }
}

function updatePrompts() {
  if (!term) {
    return;
  }
  clearPrompts();
  let promptText = ps1;
  for (let node of consoleWrapper.querySelectorAll(".cmd-wrapper div")) {
    addPromptOnLevelWith(node, promptText);
    promptText = ps2;
  }
}

function addRevsearchPrompts() {
  if (!termState.revsearch_recently_active) {
    return;
  }
  let data = document.querySelectorAll("[data-index]");
  let lastData = data[data.length - 1];
  let promptText = ps1;
  for (let node of lastData.children) {
    addPromptOnLevelWith(node, promptText);
    promptText = ps2;
  }
}

function commitPrompts() {
  for (let node of promptMargin.querySelectorAll(".input")) {
    node.classList.remove("input");
  }
}

function flushConsole() {
  if (consoleWrapper.querySelector(".partial")) {
    term.echo("");
  }
}

function isReverseSearchActive() {
  let child = document.querySelector(".cmd-prompt").children[0];
  if (!child) {
    return false;
  }
  return child.innerText.search("reverse-i-search") !== -1;
}

function clearReverseSearch() {
  term.invoke_key("CTRL+G");
}

function setIndent(node, indent) {
  node.style.marginLeft = indent ? "4ch" : "0ch";
}

const inputObserver = new MutationObserver(async (_mutationsList) => {
  if (termState.current_execution || termState.revsearch_recently_active) {
    return;
  }
  updatePrompts();
});

// Hide the prompts during reverse search
const cmdPromptObserver = new MutationObserver(async (_mutationsList) => {
  // Give keydown handler time to update revsearch_active.
  await sleep(1);
  let includePrompt = !(termState.revsearch_active || termState.reading_stdin);
  setIndent(consoleWrapper.querySelector(".cmd-wrapper"), includePrompt);
  if (includePrompt) {
    updatePrompts();
  } else {
    clearPrompts();
  }
});

async function stdinCallback() {
  termState.reading_stdin = true;
  // Formatters use global state =(
  let save = $.terminal.defaults.formatters.pop();
  try {
    setIndent(consoleWrapper.querySelector(".cmd-wrapper"), false);
    clearPrompts();
    await sleep(0);
    let result = await term.read();
    // Add a newline. stdin.readline is supposed to return lines of text
    // terminated by newlines.
    result += "\n";
    return result;
  } finally {
    $.terminal.defaults.formatters.push(save);
    setIndent(consoleWrapper.querySelector(".cmd-wrapper"), true);
    termState.reading_stdin = false;
    // term.read() seems to screw up the "ENTER" handler...
    // Put it back!
    term.keymap("ENTER", enterHandler);
  }
}

async function stdoutCallback(text) {
  let [s, newline] = process_stream_write(text);
  term.echo(s, { newline, formatters: false });
}

async function stderrCallback(text) {
  let [s, newline] = process_stream_write(text);
  term.error(s, { newline });
}

async function submit() {
  await term.invoke_key("ENTER");
}

function prism_format(code) {
  code = $.terminal.escape_brackets(code);
  code = $.terminal.prism("python", code);
  return code;
}

async function submitInner(event, original) {
  original ??= () => {};
  let cmd = term.get_command();
  if (cmd === "") {
    commitPrompts();
    term.echo("");
    updatePrompts();
    return;
  }
  let result = undefined;
  let error = undefined;
  try {
    const execution = await new Execution(cmd);
    termState.current_execution = execution;
    await execution.onStdin(stdinCallback);
    await execution.onStdout(stdoutCallback);
    await execution.onStderr(stderrCallback);
    execution.start();
    try {
      await execution.validate_syntax();
    } catch (e) {
      term.error(e.message);
      return;
    }
    term.set_command("");
    commitPrompts();
    term.echo(prism_format(cmd), {
      finalize: (node) => (node[0].style.marginLeft = "4ch"),
    });
    term.history().append(cmd);
    consoleWrapper.querySelector(".cmd-wrapper").style.display = "none";
    setIndent(consoleWrapper.querySelector(".cmd-wrapper"), false);
    try {
      result = await execution.result();
    } catch (e) {
      console.warn("error", e);
      error = e;
      return;
    }
  } finally {
    // Allow any final prints to finish before flushConsole.
    await sleep(0);
    flushConsole();
    if (result) {
      term.echo(prism_format(result.toString()));
    }
    if (error) {
      term.error(error.message);
    }
    // Make sure to show the cmd before updatePrompts, otherwise the prompts
    // might not end up in the right place.
    await sleep(0);
    let cmdWrapper = consoleWrapper.querySelector(".cmd-wrapper");
    cmdWrapper.style.display = "";
    termState.current_execution = undefined;
    updatePrompts();
    setIndent(cmdWrapper, true);
  }
}

function enterNewline(event) {
  let curLine = getCurrentInputLine();
  let leadingSpaces = curLine.match(/^\s*/)[0].length;
  if (leadingSpaces === curLine.length && !event.shiftKey) {
    unindentCurrentLine();
    return;
  }
  let endsWithColon = term.before_cursor(true).endsWith(":");
  let numSpacesToInsert = leadingSpaces;
  if (endsWithColon) {
    numSpacesToInsert = 4 + 4 * ((leadingSpaces / 4) | 0);
  }
  term.insert("\n" + " ".repeat(numSpacesToInsert));
}

async function enterHandler(event, original) {
  addRevsearchPrompts();
  if (termState.reading_stdin) {
    original();
    return;
  }
  if (event === undefined) {
    // Was triggered synthetically (by CTRL+ENTER). submit no matter
    // what.
    return await submitInner(event, original);
  }
  let shouldSubmit = true;
  shouldSubmit &&= !term.before_cursor(true).endsWith(":");
  shouldSubmit &&= !term.before_cursor(true).endsWith("\\");
  let curLine = getCurrentInputLine();
  shouldSubmit &&= !curLine.startsWith("    ");
  if (shouldSubmit) {
    return await submitInner(event, original);
  } else {
    enterNewline(event);
  }
}
window.enterHandler = enterHandler;

const keymap = {
  BACKSPACE: function (event, original) {
    if (/(^|\n)[^\S\r\n]+$/.test(term.before_cursor())) {
      unindentCurrentLine();
    } else {
      original();
    }
  },
  "CTRL+L": async function (event, original) {
    promptMargin.replaceChildren();
    original();
    await sleep(0);
    updatePrompts();
  },
  "CTRL+D": async function (event, original) {
    if (termState.reading_stdin) {
      term.pop();
      return true;
    }
  },
  "CTRL+R": async function (event, original) {
    event.preventDefault();
    if (!termState.revsearch_active) {
      termState.revsearch_before_command = term.get_command();
    }
    original(event);
  },
  "CTRL+G": async function (event, original) {
    // This function impements clearReverseSearch.
    if (event) {
      event.preventDefault();
    }
    original();
    term.set_command(termState.revsearch_before_command);
  },
  "CTRL+C": async function (event, original) {
    if (termState.reading_stdin) {
      term.pop();
      return true;
    }
    if (isReverseSearchActive()) {
      clearReverseSearch();
      return true;
    }
    if (termState.current_execution) {
      termState.current_execution.keyboardInterrupt();
      return;
    }
    for (let node of promptMargin.querySelectorAll(".input")) {
      node.classList.add("cancelled");
    }
    commitPrompts();
    term.echo(term.get_command(), {
      finalize: function (div) {
        for (let node of div[0].children) {
          if (node.firstChild) {
            node.firstChild.classList.add("cancelled");
          }
        }
        div[0].style.marginLeft = "4ch";
      },
      formatters: false,
    });
    term.set_command("");
    await sleep(0);
    updatePrompts();
  },
  "CTRL+ENTER": async function (event, original) {
    await submit();
  },
  "SHIFT+ENTER": async function (event) {
    enterNewline(event);
  },
  // "ENTER" can't be here because of the newline bug
};

const termOptions = {
  prompt: "",
  greetings: false,
  completionEscape: false,
  completion: async function (command) {
    const result = await complete(command);
    return result[0];
  },
  // onAfterEcho : async () => {
  //     if(!termState.current_execution){
  //         updatePrompts();
  //     }
  // },
  onFlush: async () => {
    await sleep(25);
    scrollToBottom();
  },
  keymap,
  // The normal history system doesn't work that well IMO, setting
  // historyFilter to false allows us to manually add items to the history.
  historyFilter: true,
  keypress: (e) => {
    let suppress_key = termState.current_execution && !termState.reading_stdin;
    let ctrls = e.ctrlKey && e.key === "C";
    suppress_key &&= !ctrls;
    return suppress_key ? false : undefined;
  },
  keydown: (e) => {
    let suppress_key = termState.current_execution && !termState.reading_stdin;
    let ctrls = e.ctrlKey && e.key === "C";
    suppress_key &&= !ctrls;
    // Handling this in keymap doesn't work for some unclear reason
    if (!suppress_key) {
      if (e.key === "ESCAPE") {
        clearReverseSearch();
        updatePrompts();
      } else if (e.key === "TAB") {
        if (e.shiftKey) {
          unindentCurrentLine();
          suppress_key = true;
        } else {
          let indentQ = term.before_cursor().match(/(?<=^|\n)\s*$/);
          if (indentQ) {
            let leadingSpaces = indentQ[0].length;
            let numSpacesToInsert = 4 - (leadingSpaces % 4);
            term.insert(" ".repeat(numSpacesToInsert));
            suppress_key = true;
          }
        }
      }
    }
    // We need special handling if the user presses "Enter" during a reverse
    // search. Pressing "Enter" will cause "revsearch_active" to be set
    // false, so we rely instead on revsearch_recently_active in the "ENTER"
    // handler. cmdPromptObserver needs revsearch_active to restore the
    // prompt when the reverse search is done.
    sleep(0).then(async () => {
      termState.revsearch_active = isReverseSearchActive();
      await sleep(10);
      termState.revsearch_recently_active = termState.revsearch_active;
    });
    return suppress_key ? false : undefined;
  },
};
