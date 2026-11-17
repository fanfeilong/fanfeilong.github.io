import MarkdownIt from 'markdown-it';

// Raw HTML stays escaped, and markdown-it retains its unsafe-URL checks.
const markdown = new MarkdownIt({html:false,linkify:false,typographer:false});
let input = '';
for await (const chunk of process.stdin) input += chunk;
const documents = JSON.parse(input);
process.stdout.write(JSON.stringify(documents.map(document=>markdown.render(document))));
