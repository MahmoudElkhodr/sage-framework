// Set apiBase to the deployed Cloudflare Worker URL, for example
//   "https://square-lake-bf88.elkhodr.workers.dev"
// While it is empty, the tool runs in DEMO MODE: everything is stored in this
// browser only, the examiner follows a fixed script, and marks are simulated.
export const CONFIG = {
  apiBase: "https://square-lake-bf88.elkhodr.workers.dev",
  avatarUrl: new URL("../assets/examiner.glb", import.meta.url).href,
  examinerName: "Sage",
  answerSeconds: 60, // maximum length of one spoken answer
  spokenAcknowledgement: true, // Sage says a brief "mhm" or "okay" the moment an answer ends; false = nod only
};
