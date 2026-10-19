import { createAgent } from "../src/bolna.ts";

const result = await createAgent();
console.log(JSON.stringify(result, null, 2));
