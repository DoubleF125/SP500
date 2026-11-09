import {readFile, writeFile, mkdir, copyFile} from 'node:fs/promises';
const read = name => readFile('src/' + name, 'utf8');
const [engine, server, html, css, ui] = await Promise.all(['engine.js','server.js','index.html','style.css','ui.js'].map(read));
await mkdir('dist/server', {recursive:true});
await mkdir('dist/.openai', {recursive:true});
await copyFile('.openai/hosting.json', 'dist/.openai/hosting.json');
await writeFile('dist/server/index.js', 'const assets = ' + JSON.stringify({'/':html,'/style.css':css,'/app.js':engine + '\n' + ui}) + ';\n' + engine + '\n' + server);
