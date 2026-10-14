// Build one portable, self-contained HTML file. No install or external runtime.
const fs = require('node:fs');
const path = require('node:path');
const read = name => fs.readFileSync(path.join(__dirname,name),'utf8');
let html = read('index.html');
html = html.replace('<link rel="stylesheet" href="style.css">', () => '<style>\n'+read('style.css')+'\n</style>');
html=html.replace('</head>',()=> '<!-- Three.js 0.160.1 license:\n'+read('vendor/THREE-LICENSE.txt')+'\n-->\n</head>');
for (const name of ['vendor/three.min.js','scene3d.js','model.js','data.js','app.js']) html=html.replace(`<script src="${name}"></script>`,()=>'<script>\n'+read(name).replace(/<\/script/gi,'<\\/script')+'\n</script>');
const file=path.join(__dirname,'traffic-wave-lab.html');
fs.writeFileSync(file,html,'utf8');
console.log('Built '+file+' ('+Buffer.byteLength(html)+' bytes)');
