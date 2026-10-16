# Reproducible workflow experiments

## Preserve shell variables inside JavaScript

Shell commands are data, not JavaScript expressions. Prefer an ordinary JS string:

```js
const command = 'd=$((RANDOM % 10 + 1)); sleep $d; echo "slept=${d}s random=$RANDOM"';
return await parallel(Array.from({length: 10}, (_, i) => () =>
  agent('Run this command and report only its actual output: ' + command, {label: 'worker-' + (i + 1)})
));
```

Putting that command unchanged in a backtick JS template evaluates `${d}` in JavaScript, where `d` does not exist. Escape the dollar sign (`\${d}`) if a template is necessary. The runtime does not rewrite interpolation because `${...}` can also be an intentional JS expression.

Errors in `parallel()` callbacks or `pipeline()` stages are included in `taskFailures`, even when they occur before any `agent()` call, including inside nested workflows. `summary.failedCallbacks` counts those errors separately from failed agent nodes; node failures propagated through the provided helpers are not counted again as callback errors. A run with callback failures cannot report `completed` merely because its agent-call count is zero. Unawaited nested workflow/iterate calls also fail the owning run and are cancelled during cleanup.

## Random-sleep experiment

To test a 15-node fan-out, request `maxConcurrency: 15` and leave enough execution time for model requests as well as the tools (for example `agentTimeoutMs: 180000`). A ten-core machine clamps the request to eight slots; excess nodes queue normally. Concurrent workflows share the host window.

Prefer lazy task functions, though promises are also supported:

```js
const ids = Array.from({ length: 15 }, (_, i) => i + 1);
return await parallel(ids.map(id => () => {
  const command = `node -e 'const {randomInt}=require("node:crypto"); const seconds=randomInt(1,21); const start=Date.now(); setTimeout(()=>console.log(JSON.stringify({id:${id},sleptSeconds:seconds,randomNumber:randomInt(1,1001),elapsedMs:Date.now()-start})),seconds*1000)'`;
  return agent(
    `Run exactly this one foreground command (timeout_ms: 30000):\n${command}\nReturn only its JSON output. Do not guess or change any values.`,
    {
      label: `sleep-${id}`,
      schema: {
        type: "object",
        properties: {
          id: { type: "integer", const: id },
          sleptSeconds: { type: "integer", minimum: 1, maximum: 20 },
          randomNumber: { type: "integer", minimum: 1, maximum: 1000 },
          elapsedMs: { type: "number", minimum: 1000 },
        },
        required: ["id", "sleptSeconds", "randomNumber", "elapsedMs"],
        additionalProperties: false,
      },
    },
  );
}));
```

Verification must compare each returned row with its child session's actual tool output. Schema validation proves shape and range, not that a model copied the observed values honestly. Check elapsed time against the selected seconds, and inspect the workflow's `summary`, `failures`, node retry counts, and final status. Aggregate results must come from those verified rows.

For cancellation tests, start running and queued nodes and then throw a deliberate script error. The terminal snapshot must have no running/queued nodes, the child processes must be gone, and neither progress nor journal may change after the tool returns. A subsequent workflow must not overlap abandoned work.
