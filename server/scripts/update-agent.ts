import { updateAgent } from "../src/bolna.ts";

const result = await updateAgent();
console.log(JSON.stringify(result, null, 2));
