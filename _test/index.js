const ttf = require('../ttf_parse')
  , fs = require('fs')
  , util = require('util')
  , readText = util.promisify(fs.readFile)
  , readJson = f => readText(f, { encoding: 'utf8' }).then(t => JSON.parse(t))
  , cbit = async (f) => {
    ttf.save('', f, null);
    var comp = await readJson('./_test/freeserif0.json');
    delete f.fname.dir; delete comp.fname.dir;
    var sd = superDiff(comp, f);
    if (sd.length == 0) console.log('PASS!!!');
    else console.log(sd.join('\n'));
  };

ttf.parse('./_test/freeserif.ttf').then(cbit)
  .catch(e => console.log(e));


function ml(a, l = 30) {
  if (typeof a === 'string' && a.length > l) return a.substr(0, l) + '...' + a.length;
  else return a;
}
function superDiff(a, b, p = []) {
  var o = [];
  for (let ka in a) {
    if (!(ka in b)) {
      o.push(p.join('.') + `.${ka} - in a only - ${ml(a[ka])}`);
    } else if (typeof a[ka] === 'object') {
      p.push(ka);
      o.push(...superDiff(a[ka], b[ka], p));
    } else if (typeof a[ka] === 'function') { // do nothing
    } else if (a[ka] !== b[ka]) {
      o.push(p.join('.') + `.${ka} - '${ml(a[ka])}' <> '${ml(b[ka])}'`);
    }
  }
  for (let kb in b) {
    if (!(kb in a)) o.push(p.join('.') + `.${kb} - in b only '${ml(b[kb])}'`);
  }
  p.pop();
  return o;
}