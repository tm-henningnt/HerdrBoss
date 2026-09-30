// Child process of the dashboard routes for `project new`. It reads the flow options as JSON from stdin,
// runs the flow module, and prints the result as JSON. The steps use synchronous Git and Herdr calls, so they run here and not in the server.
import { runProjectNew, ProjectNewError } from './project-new.js';

let text = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) text += chunk;
try {
  process.stdout.write(JSON.stringify(runProjectNew(JSON.parse(text))));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, refused: error instanceof ProjectNewError, error: error.message }));
}
