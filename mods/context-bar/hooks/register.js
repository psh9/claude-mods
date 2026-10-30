import { atom, read, update } from 'claude-code';
const snapshot = atom({ plugin: 'context-bar', key: 'snapshot' }, null);
const isShown = atom({ plugin: 'context-bar', key: 'isShown' }, true);
const hasLegend = atom({ plugin: 'context-bar', key: 'hasLegend' }, true);
const FILLED = '█';
const HOLLOW = '░';
/** Most cells the bar takes: wide enough to read each category's share. */
const BAR_CELLS = 48;
/** The colour of the fill percentage: calm, then warning, then near the limit. */
const fillColour = (percent) => percent >= 90 ? 'error' : percent >= 70 ? 'warning' : 'success';
/** Where each kind sits in the bar: what is spent, the reserve, then the room left. */
const RANK = { used: 0, buffer: 1, free: 2, deferred: 3 };
const human = (n) => {
    const t = Math.max(0, Math.round(n));
    if (t < 1000)
        return String(t);
    const k = t / 1000;
    return `${k >= 100 ? Math.round(k) : k.toFixed(1)}k`;
};
const money = (usd) => usd > 0 && usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`;
/**
 * Cells per category, summing to exactly `cells`: floor every share, hand the
 * remainder to the largest fractions, then make sure a category with tokens in
 * it never vanishes while a bigger one can spare a cell.
 */
const allocate = (rows, cells) => {
    const total = rows.reduce((sum, row) => sum + row.tokens, 0);
    if (total <= 0 || cells <= 0)
        return rows.map(row => ({ row, cells: 0 }));
    const parts = rows.map(row => {
        const exact = (row.tokens / total) * cells;
        const whole = Math.floor(exact);
        return { row, whole, fraction: exact - whole };
    });
    let left = cells - parts.reduce((sum, part) => sum + part.whole, 0);
    for (const part of [...parts].sort((a, b) => b.fraction - a.fraction)) {
        if (left <= 0)
            break;
        part.whole += 1;
        left -= 1;
    }
    for (const part of parts) {
        if (part.whole > 0 || part.row.tokens <= 0)
            continue;
        const donor = parts.reduce((best, other) => other.whole > 1 && (best === null || other.whole > best.whole) ? other : best, null);
        if (donor === null)
            break;
        donor.whole -= 1;
        part.whole = 1;
    }
    return parts.map(part => ({ row: part.row, cells: part.whole }));
};
/**
 * Reads the window from the engine. `summary` estimates locally and sends no
 * requests, so it is what the band refreshes on; `full` counts per tool and
 * memory file the way /context does, and is asked for by hand.
 */
const measure = async ($, detail) => {
    const usage = await $.session.usage({ breakdown: detail });
    const breakdown = usage.context.breakdown;
    if (breakdown === undefined)
        return null;
    const rows = breakdown.categories
        .filter(row => !row.isDeferred)
        .map(row => ({
        name: row.name,
        tokens: Math.max(0, row.tokens),
        color: row.color,
        kind: row.kind,
    }))
        .sort((a, b) => RANK[a.kind] - RANK[b.kind]);
    const taken = {
        rows,
        total: breakdown.totalTokens,
        max: breakdown.rawMaxTokens || breakdown.maxTokens,
        percent: breakdown.percentage,
        detail,
        model: breakdown.model,
        costUsd: usage.cost?.usd,
    };
    return { taken, breakdown };
};
/** The lists /context prints beneath its grid, each one itemised. */
const SECTIONS = ['skills', 'memory', 'mcp', 'agents'];
/** Each section's items, heaviest first, from a breakdown the engine gave. */
const itemise = (breakdown, section) => {
    const heaviest = (items) => [...items].sort((a, b) => b.tokens - a.tokens);
    const sum = (items) => items.reduce((total, item) => total + item.tokens, 0);
    if (section === 'skills') {
        const skills = breakdown.skills;
        const items = (skills?.skillFrontmatter ?? []).map(skill => ({
            name: skill.pluginName && !skill.name.includes(':') ? `${skill.pluginName}:${skill.name}` : skill.name,
            tokens: skill.tokens,
            note: skill.source,
        }));
        const commands = breakdown.slashCommands;
        return {
            title: 'Skills',
            tokens: skills?.tokens ?? sum(items),
            items: heaviest(items),
            footnote: [
                skills && skills.includedSkills < skills.totalSkills
                    ? `${skills.totalSkills - skills.includedSkills} of ${skills.totalSkills} skills left out of the listing's budget`
                    : undefined,
                commands
                    ? `slash commands: ${commands.includedCommands} listed, ${human(commands.tokens)}`
                    : undefined,
            ].filter(Boolean).join('; ') || undefined,
        };
    }
    if (section === 'memory') {
        const items = breakdown.memoryFiles.map(file => ({ name: file.path, tokens: file.tokens, note: file.type }));
        return { title: 'Memory files', tokens: sum(items), items: heaviest(items) };
    }
    if (section === 'agents') {
        const items = breakdown.agents.map(agent => ({ name: agent.agentType, tokens: agent.tokens, note: agent.source }));
        return { title: 'Custom agents', tokens: sum(items), items: heaviest(items) };
    }
    // MCP tools add up per server; a schema not loaded yet is outside the window.
    const servers = new Map();
    for (const tool of breakdown.mcpTools) {
        const server = servers.get(tool.serverName) ?? { tokens: 0, tools: 0, waiting: 0 };
        if (tool.isLoaded) {
            server.tokens += tool.tokens;
            server.tools += 1;
        }
        else {
            server.waiting += 1;
        }
        servers.set(tool.serverName, server);
    }
    const items = [...servers].map(([name, server]) => ({
        name,
        tokens: server.tokens,
        note: `${server.tools} tool${server.tools === 1 ? '' : 's'}${server.waiting ? `, ${server.waiting} deferred` : ''}`,
    }));
    return { title: 'MCP tools, by server', tokens: sum(items), items: heaviest(items) };
};
/** A section as text: its total, then one line per item, `limit` at most. */
const report = (section, limit = Infinity) => {
    const lines = [`${section.title} — ${human(section.tokens)}`];
    if (section.items.length === 0)
        lines.push('  (none)');
    for (const item of section.items.slice(0, limit)) {
        lines.push(`  ${human(item.tokens).padStart(6)}  ${item.name}${item.note ? `  (${item.note})` : ''}`);
    }
    const rest = section.items.slice(limit);
    if (rest.length > 0) {
        lines.push(`  ${'…'.padStart(6)}  ${rest.length} more, ${human(rest.reduce((total, item) => total + item.tokens, 0))}`);
    }
    if (section.footnote)
        lines.push(`  ${section.footnote}`);
    return lines.join('\n');
};
/**
 * Measures the window and keeps it, for the band to draw, handing back the
 * engine's breakdown for the commands that itemise it. A reading the
 * engine cannot give (no session bound yet) leaves the last one standing
 * rather than failing the hook that asked.
 */
async function refresh($, detail = 'summary') {
    let measured = null;
    try {
        measured = await measure($, detail);
    }
    catch {
        return null;
    }
    if (measured !== null) {
        const { taken } = measured;
        await update($, snapshot, () => taken);
    }
    return measured;
}
export const register = on => {
    on('session.start', async ($, e, next) => {
        await $.command.register({
            name: 'context-bar',
            description: 'Toggle the context-window bar above the prompt',
            argumentHint: 'on | off | full | legend | skills | memory | mcp | agents',
        });
        await refresh($);
        return next(e);
    });
    // The engine pushes a measurement after every turn; no polling needed.
    on('session.measure', async ($, e, next) => {
        if (e.changed.includes('context') || e.changed.includes('cost'))
            await refresh($);
        return next(e);
    });
    on('command.run', { command: 'context-bar' }, async ($, e) => {
        const arg = e.args.trim().toLowerCase();
        const section = SECTIONS.find(name => name === arg);
        if (arg === 'full' || section !== undefined) {
            const measured = await refresh($, 'full');
            if (measured === null) {
                return { text: 'No window to measure yet — the bar fills in after the first response.' };
            }
            const { taken, breakdown } = measured;
            // One section in full, or every section's heaviest items under the total.
            if (section !== undefined)
                return { text: report(itemise(breakdown, section)) };
            await update($, isShown, () => true);
            return {
                text: [
                    `Context bar counted exactly: ${human(taken.total)} of ${human(taken.max)} used (${Math.round(taken.percent)}%)${taken.costUsd === undefined ? '' : `, ${money(taken.costUsd)} spent this session`}.`,
                    ...SECTIONS.map(name => report(itemise(breakdown, name), 5)),
                    'Run /context-bar skills, memory, mcp or agents for every item.',
                ].join('\n\n'),
            };
        }
        if (arg === 'legend') {
            const shows = await update($, hasLegend, value => !value);
            return { text: `Context bar legend ${shows ? 'on' : 'off'}.` };
        }
        const wanted = arg === 'on' ? true : arg === 'off' ? false : undefined;
        const shows = wanted === undefined
            ? await update($, isShown, value => !value)
            : await update($, isShown, () => wanted);
        if (shows)
            await refresh($);
        return { text: `Context bar ${shows ? 'on' : 'off'}.` };
    });
    on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
        if (e.props.hasSurvey)
            return next(e);
        const shows = await read($, isShown);
        const taken = await read($, snapshot);
        if (!shows || taken === null)
            return next(e);
        const { Box, Text } = $.ui.resolve(e);
        const width = Math.max(20, e.props.bodyColumns);
        const spent = taken.costUsd === undefined ? '' : ` ${money(taken.costUsd)}`;
        const head = `ctx ${String(Math.round(taken.percent)).padStart(3)}%`;
        const figures = ` ${human(taken.total)}/${human(taken.max)}${spent}`;
        const cells = Math.min(BAR_CELLS, Math.max(8, width - head.length - figures.length - 1));
        const bar = allocate(taken.rows, cells)
            .filter(segment => segment.cells > 0)
            .map(({ row, cells: count }) => (<Text key={row.name} color={row.color}>
          {(row.kind === 'used' || row.kind === 'buffer' ? FILLED : HOLLOW).repeat(count)}
        </Text>));
        // The legend, when asked for, sits above the bar: the bar is the last row,
        // right over the prompt.
        const legend = [];
        if (await read($, hasLegend)) {
            const keys = [];
            let room = width;
            for (const row of taken.rows) {
                if (row.tokens <= 0)
                    continue;
                const label = ` ${row.name} ${human(row.tokens)}`;
                if (room - (label.length + 2) < 0)
                    break;
                room -= label.length + 2;
                keys.push(<Text key={`${row.name}-swatch`} color={row.color}>
            {`  ${FILLED}`}
          </Text>, <Text key={`${row.name}-label`} dimColor>
            {label}
          </Text>);
            }
            if (keys.length > 0)
                legend.push(<Box key="legend">{keys}</Box>);
        }
        return (<Box flexDirection="column">
        {legend}
        <Box key="bar">
          <Text color={fillColour(taken.percent)} bold>{head}</Text>
          <Text dimColor>{figures} </Text>
          {bar}
        </Box>
      </Box>);
    });
};
