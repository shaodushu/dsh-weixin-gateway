/**
 * Streaming markdown filter — character-level state machine that strips
 * unsupported markdown syntax on-the-fly.
 *
 * Outputs as much filtered text as possible on each `feed()` call, only
 * holding back the minimum characters needed for pattern disambiguation
 * (e.g. a trailing `*` that might become `***`).
 *
 * 微信不渲染 markdown——所有 markdown 语法都剥离（内容保留），保证回复规整：
 * - 表格 `| a | b |` → 纯文本行（表头+分隔行丢弃，数据行单元格用"，"连接）
 * - 粗体/斜体/下划线（** * *** __ _ ___）→ 标记剥离，内容保留
 * - 行内代码（`x`）→ 反引号剥离，内容保留
 * - 代码块（``` 围栏）→ 围栏行丢弃，内容保留
 * - 标题（# 1-6 级）→ 井号剥离，内容保留
 * - 分隔线（--- / *** / ___）→ 整行丢弃
 * - 引用（>）→ 标记剥离
 * - 图片（![alt](url)）→ 整体删除（微信不渲染 markdown 图片；媒体请用 [image:] 标记）
 * - 删除线（~~）→ 波浪号丢弃
 *
 * States:
 * - **sol** (start-of-line): checks for line-start patterns (```, >, #, |, ---, indent)
 * - **body**: scans for inline patterns (![, `, ***) and outputs safe chars
 * - **fence**: inside a fenced code block, passes content through until closing ```
 * - **inline**: accumulating content inside an inline marker pair
 * - **table**: holds `|` lines until the next line decides table vs plain
 */
export class StreamingMarkdownFilter {
    buf = "";
    fence = false;
    sol = true;
    inl = null;
    /** 表格状态：none=不在表格；hold=持有候选行待判断；active=已确认表格。 */
    tableMode = "none";
    /** 持有中的表格行（原始文本，含行尾换行）。 */
    tableRow = "";
    feed(delta) {
        this.buf += delta;
        return this.pump(false);
    }
    flush() {
        return this.pump(true);
    }
    pump(eof) {
        let out = "";
        while (this.buf || (eof && this.tableMode !== "none")) {
            const sLen = this.buf.length;
            const sSol = this.sol;
            const sFence = this.fence;
            const sInl = this.inl;
            const sTable = this.tableMode;
            if (this.fence)
                out += this.pumpFence(eof);
            else if (this.inl)
                out += this.pumpInline(eof);
            else if (this.sol)
                out += this.pumpSOL(eof);
            else
                out += this.pumpBody(eof);
            if (this.buf.length === sLen && this.sol === sSol &&
                this.fence === sFence && this.inl === sInl && this.tableMode === sTable)
                break;
        }
        if (eof && this.inl) {
            const markers = { image: "![", bold3: "***", italic: "*", ubold3: "___", uitalic: "_", code: "`" };
            out += (markers[this.inl.type] ?? "") + this.inl.acc;
            this.inl = null;
        }
        return out;
    }
    /** Inside a code fence: pass content through, drop the fence markers. */
    pumpFence(eof) {
        if (this.sol) {
            if (this.buf.length < 3 && !eof)
                return "";
            if (this.buf.startsWith("```")) {
                const nl = this.buf.indexOf("\n", 3);
                if (nl !== -1) {
                    this.fence = false;
                    this.buf = this.buf.slice(nl + 1);
                    this.sol = true;
                    return ""; // 丢弃闭合围栏行
                }
                if (eof) {
                    this.fence = false;
                    this.buf = "";
                    return "";
                }
                return "";
            }
            this.sol = false;
        }
        const nl = this.buf.indexOf("\n");
        if (nl !== -1) {
            const chunk = this.buf.slice(0, nl + 1);
            this.buf = this.buf.slice(nl + 1);
            this.sol = true;
            return chunk;
        }
        const chunk = this.buf;
        this.buf = "";
        return chunk;
    }
    /** At start of line: detect and consume line-start patterns, then transition to body. */
    pumpSOL(eof) {
        const b = this.buf;
        // 非表格行到达（或 EOF）→ 结束表格，flush 持有的行
        if (this.tableMode !== "none" && (b[0] !== "|" || eof)) {
            const prev = this.tableRow;
            this.tableRow = "";
            const active = this.tableMode === "active";
            this.tableMode = "none";
            return active && prev ? this.renderTableRow(prev) : prev;
        }
        if (b[0] === "\n") {
            this.buf = b.slice(1);
            return "\n";
        }
        if (b[0] === "`") {
            if (b.length < 3 && !eof)
                return "";
            if (b.startsWith("```")) {
                const nl = b.indexOf("\n", 3);
                if (nl !== -1) {
                    this.fence = true;
                    this.buf = b.slice(nl + 1); // 丢弃开围栏行
                    this.sol = true;
                    return "";
                }
                if (eof) {
                    this.buf = "";
                    return "";
                }
                return "";
            }
            this.sol = false;
            return "";
        }
        if (b[0] === "|") {
            const nl = b.indexOf("\n");
            if (nl === -1) {
                if (!eof)
                    return ""; // 行未完整，等待
                const line = b;
                this.buf = "";
                this.sol = true;
                return this.tableMode === "active" ? this.renderTableRow(line) : line;
            }
            const line = b.slice(0, nl + 1);
            this.buf = b.slice(nl + 1);
            this.sol = true;
            return this.handleTableLine(line);
        }
        if (b[0] === ">") {
            this.buf = b[1] === " " ? b.slice(2) : b.slice(1);
            this.sol = false;
            return "";
        }
        if (b[0] === "#") {
            let n = 0;
            while (n < b.length && b[n] === "#")
                n++;
            if (n === b.length && !eof)
                return "";
            if (n <= 6 && n < b.length && b[n] === " ") {
                this.buf = b.slice(n + 1);
                this.sol = false;
                return "";
            }
            if (n === b.length && eof) {
                this.buf = "";
                return "";
            }
            this.sol = false;
            return "";
        }
        if (b[0] === " " || b[0] === "\t") {
            if (b.search(/[^ \t]/) === -1 && !eof)
                return "";
            this.sol = false;
            return "";
        }
        if (b[0] === "-" || b[0] === "*" || b[0] === "_") {
            const ch = b[0];
            let j = 0;
            while (j < b.length && (b[j] === ch || b[j] === " "))
                j++;
            if (j === b.length && !eof)
                return "";
            if (j === b.length || b[j] === "\n") {
                let count = 0;
                for (let k = 0; k < j; k++)
                    if (b[k] === ch)
                        count++;
                if (count >= 3) {
                    // 分隔线（--- / *** / ___）→ 整行丢弃（微信不渲染）；上一行的换行已
                    // 输出，这里不补 \n（否则多一个空行）
                    if (j < b.length) {
                        this.buf = b.slice(j + 1);
                        this.sol = true;
                        return "";
                    }
                    this.buf = "";
                    return "";
                }
            }
            this.sol = false;
            return "";
        }
        this.sol = false;
        return "";
    }
    /**
     * 表格行处理（行首 `|`）：持有候选行，等下一行决定是表格还是普通管道行。
     * - 候选行 + 分隔行（|---|）→ 表头+分隔行丢弃，进入表格态
     * - 候选行 + 普通行 → 上一行按原样输出（非表格）
     * - 表格态中每行在下一行到达时输出（渲染为纯文本），保证流式
     */
    handleTableLine(line) {
        const body = line.replace(/\n$/, "");
        const isSep = /^[\s|:|-]+$/.test(body) && body.includes("-") && body.includes("|");
        if (this.tableMode === "hold") {
            const prev = this.tableRow;
            this.tableRow = "";
            if (isSep) {
                this.tableMode = "active";
                return ""; // 表头 + 分隔行丢弃
            }
            this.tableMode = "hold";
            this.tableRow = line;
            return prev; // 单行管道文本（非表格）原样输出
        }
        if (this.tableMode === "active") {
            if (this.tableRow === "") {
                // 分隔行后的第一行数据：先持有（上一行是空分隔行，无可渲染内容）
                this.tableRow = line;
                return "";
            }
            const prev = this.renderTableRow(this.tableRow);
            if (isSep) {
                this.tableRow = "";
                this.tableMode = "none"; // 表格中途出现分隔行 → 结束表格
                return prev;
            }
            this.tableRow = line;
            return prev;
        }
        // none → 候选表头
        this.tableMode = "hold";
        this.tableRow = line;
        return "";
    }
    /** 表格数据行渲染为纯文本：去管道符，单元格用"，"连接。 */
    renderTableRow(line) {
        const body = line.replace(/\n$/, "");
        const cells = body.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
        const row = cells.filter(Boolean).join("，");
        return row ? `${row}\n` : "\n";
    }
    /** Scan line body for inline pattern triggers; output safe chars eagerly. */
    pumpBody(eof) {
        let out = "";
        let i = 0;
        while (i < this.buf.length) {
            const c = this.buf[i];
            if (c === "\n") {
                out += this.buf.slice(0, i + 1);
                this.buf = this.buf.slice(i + 1);
                this.sol = true;
                return out;
            }
            if (c === "!" && i + 1 < this.buf.length && this.buf[i + 1] === "[") {
                out += this.buf.slice(0, i);
                this.buf = this.buf.slice(i + 2);
                this.inl = { type: "image", acc: "" };
                return out;
            }
            if (c === "`") {
                out += this.buf.slice(0, i);
                this.buf = this.buf.slice(i + 1);
                this.inl = { type: "code", acc: "" };
                return out;
            }
            if (c === "~") {
                out += this.buf.slice(0, i);
                this.buf = this.buf.slice(i + 1);
                return out; // 删除线波浪号丢弃（内容保留），立即续扫
            }
            if (c === "*") {
                if (i + 1 < this.buf.length && this.buf[i + 1] === "*") {
                    if (i + 2 < this.buf.length && this.buf[i + 2] === "*") {
                        out += this.buf.slice(0, i);
                        this.buf = this.buf.slice(i + 3);
                        this.inl = { type: "bold3", acc: "" };
                        return out;
                    }
                    out += this.buf.slice(0, i);
                    this.buf = this.buf.slice(i + 2);
                    this.inl = { type: "bold2", acc: "" };
                    return out;
                }
                if (i + 1 < this.buf.length && this.buf[i + 1] !== " " && this.buf[i + 1] !== "\n") {
                    out += this.buf.slice(0, i);
                    this.buf = this.buf.slice(i + 1);
                    this.inl = { type: "italic", acc: "" };
                    return out;
                }
                i++;
                continue;
            }
            if (c === "_") {
                if (i + 1 < this.buf.length && this.buf[i + 1] === "_") {
                    if (i + 2 < this.buf.length && this.buf[i + 2] === "_") {
                        out += this.buf.slice(0, i);
                        this.buf = this.buf.slice(i + 3);
                        this.inl = { type: "ubold3", acc: "" };
                        return out;
                    }
                    out += this.buf.slice(0, i);
                    this.buf = this.buf.slice(i + 2);
                    this.inl = { type: "ubold2", acc: "" };
                    return out;
                }
                if (i + 1 < this.buf.length && this.buf[i + 1] !== " " && this.buf[i + 1] !== "\n") {
                    out += this.buf.slice(0, i);
                    this.buf = this.buf.slice(i + 1);
                    this.inl = { type: "uitalic", acc: "" };
                    return out;
                }
                i++;
                continue;
            }
            i++;
        }
        let hold = 0;
        if (!eof) {
            if (this.buf.endsWith("**"))
                hold = 2;
            else if (this.buf.endsWith("__"))
                hold = 2;
            else if (this.buf.endsWith("*"))
                hold = 1;
            else if (this.buf.endsWith("_"))
                hold = 1;
            else if (this.buf.endsWith("`"))
                hold = 1;
            else if (this.buf.endsWith("!"))
                hold = 1;
        }
        out += this.buf.slice(0, this.buf.length - hold);
        this.buf = hold > 0 ? this.buf.slice(-hold) : "";
        return out;
    }
    /** Accumulate inline content until closing marker is found. */
    pumpInline(_eof) {
        if (!this.inl)
            return "";
        this.inl.acc += this.buf;
        this.buf = "";
        switch (this.inl.type) {
            case "bold3": {
                const idx = this.inl.acc.indexOf("***");
                if (idx !== -1) {
                    const content = this.inl.acc.slice(0, idx);
                    this.buf = this.inl.acc.slice(idx + 3);
                    this.inl = null;
                    return content; // 标记剥离，内容保留（微信不渲染粗体）
                }
                return "";
            }
            case "bold2": {
                const idx = this.inl.acc.indexOf("**");
                if (idx !== -1) {
                    const content = this.inl.acc.slice(0, idx);
                    this.buf = this.inl.acc.slice(idx + 2);
                    this.inl = null;
                    return content;
                }
                return "";
            }
            case "ubold3": {
                const idx = this.inl.acc.indexOf("___");
                if (idx !== -1) {
                    const content = this.inl.acc.slice(0, idx);
                    this.buf = this.inl.acc.slice(idx + 3);
                    this.inl = null;
                    return content;
                }
                return "";
            }
            case "ubold2": {
                const idx = this.inl.acc.indexOf("__");
                if (idx !== -1) {
                    const content = this.inl.acc.slice(0, idx);
                    this.buf = this.inl.acc.slice(idx + 2);
                    this.inl = null;
                    return content;
                }
                return "";
            }
            case "italic": {
                for (let j = 0; j < this.inl.acc.length; j++) {
                    if (this.inl.acc[j] === "\n") {
                        const r = "*" + this.inl.acc.slice(0, j + 1);
                        this.buf = this.inl.acc.slice(j + 1);
                        this.inl = null;
                        this.sol = true;
                        return r;
                    }
                    if (this.inl.acc[j] === "*") {
                        if (j + 1 < this.inl.acc.length && this.inl.acc[j + 1] === "*") {
                            j++;
                            continue;
                        }
                        const content = this.inl.acc.slice(0, j);
                        this.buf = this.inl.acc.slice(j + 1);
                        this.inl = null;
                        return content;
                    }
                }
                return "";
            }
            case "uitalic": {
                for (let j = 0; j < this.inl.acc.length; j++) {
                    if (this.inl.acc[j] === "\n") {
                        const r = "_" + this.inl.acc.slice(0, j + 1);
                        this.buf = this.inl.acc.slice(j + 1);
                        this.inl = null;
                        this.sol = true;
                        return r;
                    }
                    if (this.inl.acc[j] === "_") {
                        if (j + 1 < this.inl.acc.length && this.inl.acc[j + 1] === "_") {
                            j++;
                            continue;
                        }
                        const content = this.inl.acc.slice(0, j);
                        this.buf = this.inl.acc.slice(j + 1);
                        this.inl = null;
                        return content;
                    }
                }
                return "";
            }
            case "code": {
                const idx = this.inl.acc.indexOf("`");
                if (idx !== -1) {
                    const content = this.inl.acc.slice(0, idx);
                    this.buf = this.inl.acc.slice(idx + 1);
                    this.inl = null;
                    return content; // 反引号剥离，内容保留
                }
                const nl = this.inl.acc.indexOf("\n");
                if (nl !== -1) {
                    // 行内代码跨行（异常）→ 恢复反引号原样
                    const r = "`" + this.inl.acc.slice(0, nl + 1);
                    this.buf = this.inl.acc.slice(nl + 1);
                    this.inl = null;
                    this.sol = true;
                    return r;
                }
                return "";
            }
            case "image": {
                const cb = this.inl.acc.indexOf("]");
                if (cb === -1)
                    return "";
                if (cb + 1 >= this.inl.acc.length)
                    return "";
                if (this.inl.acc[cb + 1] !== "(") {
                    const r = "![" + this.inl.acc.slice(0, cb + 1);
                    this.buf = this.inl.acc.slice(cb + 1);
                    this.inl = null;
                    return r;
                }
                const cp = this.inl.acc.indexOf(")", cb + 2);
                if (cp !== -1) {
                    this.buf = this.inl.acc.slice(cp + 1);
                    this.inl = null;
                    return "";
                }
                return "";
            }
        }
        return "";
    }
}
