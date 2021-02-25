import {Execution, initializePyodide, pyodide, banner, complete} from "./pyodide-main.js";

let term;
export {term, pyodide, init};

function sleep(t){
    return new Promise(resolve => setTimeout(resolve, t));
}

function countLines(str){
    return (str.match(/\n/g) || '').length + 1;
}

function getCurrentInputLine(){
    return term.get_command().split("\n")[countLines(term.before_cursor()) - 1];
}

function setCurrentInputLine(value){
    let lines = term.get_command().split("\n");
    lines[countLines(term.before_cursor()) - 1] = value;
    term.set_command(lines.join("\n"));
}

function unindentCurrentLine(){
    let curLine = getCurrentInputLine();
    let trimmedLine = curLine.trimStart();
    let leadingSpaces = curLine.length - trimmedLine.length;
    setCurrentInputLine(" ".repeat(4*(((leadingSpaces-1)/4)|0)) + trimmedLine);
}

function process_stream_write(s){
    let newline = s.endsWith("\n");
    if(newline){
        s = s.slice(0, -1);
    }
    return [s, newline];
}

const termState =  {
    current_execution: undefined,
    reading_stdin: false,
    last_stdout: "",
    revsearch_active: false,
    revsearch_recently_active : false,
    revsearch_before_command : undefined,
};
// A private use area unicode character
const inputTagCharacter = "\uE000";
const zeroWidthSpace = "\u200B";

const ps1 = ">>> ", ps2 = "... ";

const promptMargin = document.querySelector(".console-prompt-margin");
const consoleWrapper = document.querySelector(".console-wrapper");

function clearPrompts(){
    for(let node of promptMargin.querySelectorAll(".input")){
        node.remove();
    }
}

function addPromptOnLevelWith(node, text){
    let top = node.getBoundingClientRect().top;
    let span = document.createElement("span");
    let term_top = consoleWrapper.getBoundingClientRect().top;
    span.style.top = `${top - term_top}px`;
    span.style.position = "absolute";
    span.innerText = text;
    span.className = "input";
    promptMargin.appendChild(span);
}

function updatePrompts(){
    clearPrompts();
    let promptText = ps1;
    for(let node of consoleWrapper.querySelectorAll(".cmd-wrapper div")){
        addPromptOnLevelWith(node, promptText);
        promptText = ps2;
    }
}

function addRevsearchPrompts(){
    if(!termState.revsearch_recently_active){
        return;
    }
    let data = document.querySelectorAll("[data-index]");
    let lastData = data[data.length - 1];
    let promptText = ps1;
    for(let node of lastData.children){
        addPromptOnLevelWith(node, promptText);
        promptText = ps2;
    }
}

function commitPrompts(){
    for(let node of promptMargin.querySelectorAll(".input")){
        node.classList.remove("input");
    }
}

function flushConsole(){
    if(consoleWrapper.querySelector(".cmd-prompt").innerText){
        term.echo("");
    }
}

function isReverseSearchActive(){
    let child = document.querySelector(".cmd-prompt").children[0];
    if(!child) {
        return false;
    }
    return child.innerText.search("reverse-i-search") !== -1;
}

function clearReverseSearch(){
    term.keymap()["CTRL+G"]();
}

function setIndent(node, indent){
    node.style.marginLeft = indent ? "4ch" : "0ch";
}

const inputObserver = new MutationObserver(async (_mutationsList) => {
    if(termState.current_execution || termState.revsearch_recently_active){
        return;
    }
    updatePrompts();
});

// Control indentation of text in output region
const outputObserver = new MutationObserver((mutationsList) => {
    for(let mutation of mutationsList){
        for(let node of mutation.addedNodes){
            let span = node.firstChild.firstChild;
            if(span && span.innerText.startsWith(inputTagCharacter)){
                span.innerText = span.innerText.slice(1);
                span.setAttribute("data-text", span.innerText);
                node.style.marginLeft = "4ch";
            }
        }
    }
});

// Hide the prompts during reverse search or during "input", display them again when trimmed.
const cmdPromptObserver = new MutationObserver(async (_mutationsList) => {
    let hasPrompt = false;
    // We don't use the cmd-prompt for anything normal, but reverse search uses
    // it and also echo_newline.js uses it to store partial lines of text. So
    // input("prompt text") will stick "prompt text" into the prompt which will
    // no longer be empty. We insert a zero width space in front of 
    for(let node of consoleWrapper.querySelector(".cmd-prompt").children){
        hasPrompt ||= node.innerText.trim() !== "";
    }
    setIndent(consoleWrapper.querySelector(".cmd-wrapper"), !hasPrompt);
    // Give keydown handler time to update revsearch_active.
    await sleep(1);
    if(hasPrompt || termState.revsearch_active){
        clearPrompts();
    } else {
        updatePrompts();
    }
});

async function stdinCallback() {
    term.resume();
    termState.reading_stdin = true;
    try {
        // Prepend a zeroWidthSpace to insure that the prompt is not empty.
        // This is to allow detection in cmdPromptObserver
        return await term.read(zeroWidthSpace + termState.last_stdout);
    } finally {
        termState.reading_stdin = false;
        // term.read() seems to screw up the "ENTER" handler... 
        // Put it back!
        term.keymap("ENTER", enterHandler);
    }
}

async function stdoutCallback(text){
    termState.last_stdout = text;
    let [s, newline] = process_stream_write(text);
    term.echo(s, { newline });
}

async function stderrCallback(text) {
    let [s, newline] = process_stream_write(text);
    term.error(s, { newline });
}

async function submit(){
    await term.keymap()["ENTER"]();
}

async function submitInner(event, original){
    original ??= (() => {});
    let cmd = term.get_command();
    addRevsearchPrompts();
    if(termState.reading_stdin){
        original();
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
        } catch(e) {
            term.error(e);
            return;
        }
        term.set_command("");
        commitPrompts();
        // print input tagged so that outputObserver will know to indent it
        term.echo(inputTagCharacter + cmd); 
        term.history().append(cmd);
        consoleWrapper.querySelector(".cmd-wrapper").style.display = "none";
        try {
            result = await execution.result();
        } catch(e){
            console.warn("error", e);
            error = e;
            return;
        }
    } finally {
        // Allow any final prints to finish before flushConsole.
        await sleep(0);
        flushConsole();
        if(result){
            term.echo(result);
        }
        if(error){
            term.error(error);
        }
        // Make sure to show the cmd before updatePrompts, otherwise the prompts
        // might not end up in the right place.
        let cmdWrapper = consoleWrapper.querySelector(".cmd-wrapper");
        cmdWrapper.style.display = "";
        await sleep(0);
        termState.current_execution = undefined;
        updatePrompts();
        setIndent(cmdWrapper, true);
    }
}

function enterNewline(event){
    let curLine = getCurrentInputLine();
    let leadingSpaces = curLine.match(/^\s*/)[0].length;
    if(leadingSpaces === curLine.length && !event.shiftKey){
        unindentCurrentLine();
        return;
    }
    let endsWithColon = term.before_cursor(true).endsWith(":");
    let numSpacesToInsert = leadingSpaces;
    if(endsWithColon){
        numSpacesToInsert = 4 + 4*((leadingSpaces/4)|0);
    }
    term.insert("\n" + " ".repeat(numSpacesToInsert));
}

async function enterHandler(event, original) { 
    if(event === undefined){
        // Was triggered synthetically (by CTRL+ENTER). submit no matter
        // what.
        return await submitInner(event, original);
    } 
    let shouldSubmit = true;
    shouldSubmit &&= !term.before_cursor(true).endsWith(":");
    shouldSubmit &&= !term.before_cursor(true).endsWith("\\");
    let curLine = getCurrentInputLine();
    shouldSubmit &&= !curLine.startsWith("    ");
    if(shouldSubmit){
        return await submitInner(event, original);
    } else {
        enterNewline(event);
    }
}
window.enterHandler = enterHandler;

const keymap = {
    "BACKSPACE" : function(event, original){
        original();
    },
    "CTRL+L" : async function(event, original){
        promptMargin.replaceChildren();
        original();
        await sleep(0);
        updatePrompts();
    },
    "CTRL+D" : async function(event, original){
        if(termState.reading_stdin){
            term.pop();
            return true;
        }
    },
    "CTRL+R" : async function(event, original){
        event.preventDefault();
        if(!termState.revsearch_active){
            termState.revsearch_before_command = term.get_command();
        }
        original(event);
    },
    "CTRL+G" : async function(event, original){
        // This function impements clearReverseSearch.
        if(event){
            event.preventDefault();
        }
        original();
        term.set_command(termState.revsearch_before_command);
    },
    "CTRL+C" : async function(event, original){
        if(termState.reading_stdin){
            term.pop();
            return true;
        }
        if(isReverseSearchActive()){
            clearReverseSearch();
            return true;
        }
        if(termState.current_execution){
            termState.current_execution.keyboardInterrupt();
        }
        for(let node of promptMargin.querySelectorAll(".input")){
            node.classList.add("cancelled");
        }
        commitPrompts();
        term.echo(
            inputTagCharacter + term.get_command(),
            {
                finalize: function(div) {
                    for(let node of div[0].children){
                        node.firstChild.classList.add("cancelled");
                    }
                }
            }
        );
        term.set_command("");
        await sleep(0);
        updatePrompts();
    },
    "CTRL+ENTER": async function(event, original) { 
        await submit();
    },
    "SHIFT+ENTER": async function(event){
        enterNewline(event);
    },
    // "ENTER" can't be here because of the newline bug
};

const termOptions = {
    // prompt: "", // triggered bug
    // https://github.com/jcubic/jquery.terminal/issues/651
    completionEscape: false,
    completion: async function(command) {
        return await complete(command);
    },
    keymap,
    // The normal history system doesn't work that well IMO, setting
    // historyFilter to false allows us to manually add items to the history. 
    historyFilter : true,
    keypress : (e) => {
        let suppress_key = termState.current_execution && !termState.reading_stdin;
        let ctrls =  e.ctrlKey && (e.key === "C");
        suppress_key &&= !ctrls;
        return suppress_key ? false : undefined;
    },
    keydown : (e) => {
        let suppress_key = termState.current_execution && !termState.reading_stdin;
        let ctrls =  e.ctrlKey && (e.key === "C");
        suppress_key &&= !ctrls;
        // Handling this in keymap doesn't work for some unclear reason
        if(!suppress_key){
            if(e.key === "ESCAPE"){
                clearReverseSearch();
                updatePrompts();
            } else if(e.key === "TAB"){
                if(e.shiftKey){
                    unindentCurrentLine();
                    suppress_key = true;
                } else {
                    let indentQ = term.before_cursor().match(/(?<=^|\n)\s*$/);
                    if(indentQ){
                        let leadingSpaces = indentQ[0].length;
                        let numSpacesToInsert = 4 - (leadingSpaces % 4);
                        console.log("numSpacesToInsert",numSpacesToInsert);
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
    }
};

async function init() {
    await initializePyodide();
    // Banner is produced from Python so it doesn't get populated until "ready".
    termOptions.greetings = banner;
    term = $(".terminal").terminal(
        (command) => {},
        termOptions  
    );
    term.set_prompt("");
    // We have to put in "ENTER" here because of the newline bug
    term.keymap("ENTER", enterHandler);
    updatePrompts();
    inputObserver.observe(consoleWrapper.querySelector(".cmd-wrapper"), { childList : true });
    outputObserver.observe(consoleWrapper.querySelector(".terminal-output"), { childList : true });
    cmdPromptObserver.observe(consoleWrapper.querySelector(".cmd-prompt"), { childList : true });
}