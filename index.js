import {Execution, initializePyodide, pyodide, banner, complete} from "./pyodide-main.js";

let term;
export {term, pyodide, init};

function sleep(t){
    return new Promise(resolve => setTimeout(resolve, t));
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
    is_output : false,
    reading_stdin: false,
    last_stdout: "",
    revsearch_active: false,
    revsearch_recently_active : false,
};

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
        node.className = "";
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

function setIndent(node, indent){
    node.style.marginLeft = indent ? "4ch" : "0ch";
}

const inputObserver = new MutationObserver(async (_mutationsList) => {
    if(termState.current_execution || termState.revsearch_recently_active){
        return;
    }
    updatePrompts();
});

const outputObserver = new MutationObserver((mutationsList) => {
    for(let mutation of mutationsList){
        if(termState.is_output){
            mutation.addedNodes[0].style.marginLeft = "0ch";
        }
    }
});

const cmdPromptObserver = new MutationObserver(async (_mutationsList) => {
    let hasPrompt = false;
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
        return await term.read(termState.last_stdout);
    } finally {
        termState.reading_stdin = false;
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

const keymap = {
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
    "CTRL+C" : async function(event, original){
        if(termState.reading_stdin){
            term.pop();
            return true;
        }
        if(isReverseSearchActive()){
            // TODO: Can we handle this?
            return true;
        }
        if(termState.current_execution){
            termState.current_execution.keyboardInterrupt();
        }
        original();
        // await sleep(10);
        commitPrompts();
        updatePrompts();
    },
    ENTER: async function(event, original) { 
        let cmd = term.get_command();
        addRevsearchPrompts();
        if(termState.reading_stdin){
            original();
            return;
        }
        commitPrompts();
        let result = undefined;
        let error = undefined;
        try {
            term.set_command("");
            const execution = await new Execution(cmd);
            termState.current_execution = execution;
            // Before setting is_output to true, we need to sleep to allow
            // the input lines to be printed with is_output false.
            await sleep(0);
            termState.is_output = true;
            await execution.onStdin(stdinCallback);
            await execution.onStdout(stdoutCallback);
            await execution.onStderr(stderrCallback);
            execution.start();
            try {
                await execution.validate_syntax();
            } catch(e) {
                term.set_command(cmd);
                term.error(e);
                return;
            }
            term.history().append(cmd);
            await original();
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
            // Allow the output to be printed before we set is_output to false.
            await sleep(0);
            termState.is_output = false;
            termState.current_execution = undefined;
            updatePrompts();
            setIndent(consoleWrapper.querySelector(".cmd-wrapper"), true);
        }
    }
};

const termOptions = {
    prompt: "",
    completionEscape: false,
    completion: async function(command) {
        return await complete(command);
    },
    // The normal history system doesn't work that well IMO, setting
    // historyFilter to false allows us to manually add items to the history. 
    historyFilter : true,
    keymap,
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
    updatePrompts();
    setIndent(consoleWrapper.querySelector("[data-index='0']"), false);
    inputObserver.observe(consoleWrapper.querySelector(".cmd-wrapper"), { childList : true });
    outputObserver.observe(consoleWrapper.querySelector(".terminal-output"), { childList : true });
    cmdPromptObserver.observe(consoleWrapper.querySelector(".cmd-prompt"), { childList : true });
}