// ---------- Utility Types ----------

type Nullable<T> = T | null;

// VS Code Webview API
interface VSCodeApi<T = unknown> {
    postMessage(message: unknown): void;
    getState(): T | undefined;
    setState(state: T): void;
}

declare function acquireVsCodeApi<T = unknown>(): VSCodeApi<T>;

// External globals (no typings assumed)
declare const Tabulator: any;
declare const Prism: any;
declare const codeInput: any;
declare const CHUNK_SIZE: number;

// ---------- DOM Helpers ----------

// Provides callback for when HTML element loads
function waitForElement<T extends Element>(selector: string): Promise<T> {
    return new Promise(resolve => {
        const existing = document.querySelector<T>(selector);
        if (existing) {
            resolve(existing);
            return;
        }

        const observer = new MutationObserver(() => {
            const element = document.querySelector<T>(selector);
            if (element) {
                resolve(element);
                observer.disconnect();
            }
        });

        observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
        });
    });
}

function waitForElements<T extends readonly string[]>(
    selectors: T
): Promise<{ [K in keyof T]: Element }> {
    return new Promise(resolve => {
        let numWaiting = selectors.length;
        const elements: Element[] = new Array(selectors.length);

        const callback = (element: Element, index: number) => {
            elements[index] = element;
            numWaiting--;
            if (numWaiting === 0) {
                resolve(elements as { [K in keyof T]: Element });
            }
        };

        selectors.forEach((selector, index) => {
            waitForElement(selector).then(el => callback(el, index));
        });
    });
}

// ---------- Tabulator Helpers ----------

// https://tabulator.info/docs/6.2/format
function getFormatter(columnType: string): Record<string, unknown> {
    switch (columnType) {
        case "DATE":
            return {
                formatter: "datetime",
                formatterParams: {
                    inputFormat: "iso",
                    outputFormat: "yyyy-MM-dd",
                    timezone: "utc",
                },
            };
        default:
            return {};
    }
}

// ---------- Message Types ----------

interface DescribeColumn {
    column_name: string;
    column_type: string;
}

interface QueryMessage {
    type: "query";
    autoQuery?: boolean;
    results?: unknown[];
    describe?: DescribeColumn[];
    message?: string;
}

interface MoreMessage {
    type: "more";
    results: unknown[];
}

interface ConfigMessage {
    type: "config";
    autoQuery?: boolean;
}

type IncomingMessage = QueryMessage | MoreMessage | ConfigMessage;

interface CodeInputElement extends HTMLElement {
    value: string;
}

// ---------- Main ----------

(function () {
    const vscode = acquireVsCodeApi<{ sql?: string }>();

    let autoQuery = true;

    let textAreaElement: Nullable<HTMLTextAreaElement> = null;
    let loadingIconElement: Nullable<HTMLElement> = null;
    let errorMessageElement: Nullable<HTMLElement> = null;
    let tableElement: Nullable<HTMLElement> = null;
    let table: any = null;
    let lastSql: string | undefined;

    // Whether the spinner is currently showing
    let loadingScroll = false;

    // Whether or not there's additional query results to load
    let moreToLoad = false;

    // Offset to use when fetching additional results
    let scrollOffset = 0;

    // Handle messages sent from the extension to the webview
    window.addEventListener("message", (event: MessageEvent<IncomingMessage>) => {
        const message = event.data;

        switch (message.type) {
            case "config":
                autoQuery = !!message.autoQuery;
                break;

            case "query":
                loadingScroll = false;
                loadingIconElement!.style.display = "none";
                textAreaElement!.disabled = false;

                if (message.results && message.describe) {
                    tableElement!.style.display = "block";
                    moreToLoad = message.results.length >= CHUNK_SIZE;
                    scrollOffset = 0;

                    const columns = [
                        {
                            formatter: "rownum",
                            hozAlign: "right",
                            headerHozAlign: "center",
                            width: 1,
                            frozen: true,
                            resizable: false,
                        },
                        ...message.describe.map(column => ({
                            title: column.column_name,
                            field: column.column_name,
                            headerTooltip: column.column_type,
                            ...getFormatter(column.column_type),
                        })),
                    ];

                    if (table) {
                        table.replaceData(message.results);
                        table.setColumns(columns);
                    } else {
                        table = new Tabulator("#results", {
                            height: "calc(100% + 10vh)",
                            data: message.results,
                            layout: "fitData",
                            placeholder: "No Results",
                            resizableColumnGuide: true,
                            columnDefaults: {
                                resizable: true,
                                headerSort: false,
                                formatter: "textarea",
                                maxInitialWidth: window.innerWidth * 0.4,
                            },
                            columns,
                        });

                        table.on("scrollVertical", (top: number) => {
                            const element = table.rowManager.element;
                            if (
                                top >= element.scrollHeight - element.offsetHeight &&
                                !loadingScroll &&
                                moreToLoad
                            ) {
                                loadingScroll = true;
                                scrollOffset += CHUNK_SIZE;

                                loadingIconElement!.style.display = "block";
                                textAreaElement!.disabled = true;

                                const sql = (textAreaElement!.parentElement as CodeInputElement).value;

                                vscode.postMessage({
                                    type: "more",
                                    sql,
                                    limit: CHUNK_SIZE,
                                    offset: scrollOffset,
                                });
                            }
                        });
                    }
                } else if (message.message) {
                    tableElement!.style.display = "none";
                    errorMessageElement!.style.display = "block";
                    errorMessageElement!.textContent = message.message;
                }
                break;

            case "more":
                loadingScroll = false;
                loadingIconElement!.style.display = "none";
                textAreaElement!.disabled = false;

                if (message.results.length < CHUNK_SIZE) {
                    moreToLoad = false;
                }

                if (message.results.length > 0 && table) {
                    table.addData(message.results);
                }
                break;
        }
    });

    // Initialize the text area syntax highlighting
    codeInput.registerTemplate(
        "syntax-highlighted",
        codeInput.templates.prism(Prism, [new codeInput.plugins.Indent()])
    );

    // ---------- Event Handlers ----------

    const onKeyDown = (event: KeyboardEvent) => {
        if ((event.ctrlKey || event.metaKey) && event.code === "Enter") {
            event.preventDefault();
            event.stopPropagation();
            runQuery();
        }
    };

    const onInput = (event: Event) => {
        const target = event.target as HTMLTextAreaElement;
        vscode.setState({ sql: (target.parentElement as CodeInputElement).value });
    };

    const onChange = () => {
        if (autoQuery) {
            runQuery();
        }
    };

    const runQuery = () => {
        const sql = (textAreaElement!.parentElement as CodeInputElement).value;

        // Ctrl/Cmd + Enter causes onChange to be called twice
        if (sql === lastSql) return;
        lastSql = sql;

        loadingScroll = true;
        tableElement!.style.display = "none";
        loadingIconElement!.style.display = "block";
        errorMessageElement!.style.display = "none";
        textAreaElement!.disabled = true;

        if (table) {
            table.replaceData([]);
            table.setColumns([]);
        }

        vscode.postMessage({
            type: "query",
            sql,
            limit: CHUNK_SIZE,
        });
    };

    // ---------- Init ----------

    waitForElements(["textarea", "#results", "#loadingIcon", "#errorMessage"] as const).then(
        ([textarea, results, loadingIcon, errorMessage]) => {
            textAreaElement = textarea as HTMLTextAreaElement;
            tableElement = results as HTMLElement;
            loadingIconElement = loadingIcon as HTMLElement;
            errorMessageElement = errorMessage as HTMLElement;

            textAreaElement.addEventListener("input", onInput);
            textAreaElement.addEventListener("change", onChange);
            textAreaElement.addEventListener("keydown", onKeyDown, true);

            const state = vscode.getState();
            if (state?.sql) {
                (textarea.parentElement as CodeInputElement).value = state.sql;
            }

            textarea.dispatchEvent(new Event("input"));
            textarea.dispatchEvent(new Event("change"));
        }
    );
})();
