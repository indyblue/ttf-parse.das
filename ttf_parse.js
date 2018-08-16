const fs = require('fs')
	, util = require('util')
	, ptool = require('path')
	, b85 = require('base85')
	//, lzw = require("node-lzw");
	, zlib = require('zlib')
	, fopen = util.promisify(fs.open)
	, fread = util.promisify(fs.read)
	, readFile = util.promisify(fs.readFile)
	, writeFile = util.promisify(fs.writeFile)

var debug = false;

const getBuff = async (fd, offset, length, cb) => {
	let buff = new Buffer(length);
	const { bytesRead, buffer } = await fread(fd, buff, 0, length, offset);
	buffer.bytesRead = bytesRead;
	return buffer;
};
var ro = {
	ulong: async (fd, offset) => {
		if (Buffer.isBuffer(fd)) return fd.readUInt32BE(offset);
		let buff = await getBuff(fd, offset, 4);
		return buff.readUInt32BE(0);
	},
	ushort: async (fd, offset, cb) => {
		if (Buffer.isBuffer(fd)) return fd.readUInt16BE(offset);
		let buff = await getBuff(fd, offset, 2);
		return buff.readUInt16BE(0);
	},
	ubyte: async (fd, offset, cb) => {
		if (Buffer.isBuffer(fd)) return fd.readUInt8(offset);
		let buff = await getBuff(fd, offset, 1);
		return buff.readUInt8(0);
	},
	short: async (fd, offset, cb) => {
		if (Buffer.isBuffer(fd)) return fd.readInt16BE(offset);
		let buff = await getBuff(fd, offset, 2);
		return buff.readInt16BE(0);
	},
	fixed: async (fd, offset, cb) => {
		if (Buffer.isBuffer(fd))
			return parseFloat('' + fd.readInt16BE(offset) + '.' + fd.readUInt16BE(offset + 2));
		let buff = await getBuff(fd, offset, 4);
		return parseFloat('' + buff.readInt16BE(0) + '.' + buff.readUInt16BE(2));
	},
	substr: async (fd, offset, length, cb) => {
		if (Buffer.isBuffer(fd)) return fd.toString('utf8', offset, offset + length);
		let buff = await getBuff(fd, offset, length);
		return buff.toString();
	},
	getBuff
};

var clttf = () => ({
	isPc: true,
	fb: null,
	d: {},
	parseTTF: async function () {
		var fb = this.fb;
		await this.getTables();
		var tables = this.d.tables;

		//magic number check
		var o = tables.head.offset + 12;
		var magic = await ro.ulong(fb, o);
		if (debug) this.log('magic 0x' + magic.toString(16) + ' == 0x5f0f3cf5');
		if (magic != 0x5F0F3CF5) return false;

		//get metrics
		var metric = {};
		var fdesc = {};
		this.d.metric = metric;
		this.d.fdesc = fdesc;
		o += 6;
		metric.unitsPerEm = await ro.ushort(fb, o);
		var urk = 1000 / metric.unitsPerEm;
		metric.urk = urk;
		o += 18;
		var xmin = Math.round(await ro.short(fb, o) * urk); o += 2;
		var ymin = Math.round(await ro.short(fb, o) * urk); o += 2;
		var xmax = Math.round(await ro.short(fb, o) * urk); o += 2;
		var ymax = Math.round(await ro.short(fb, o) * urk); o += 2;
		metric.bbox = '[' + [xmin, ymin, xmax, ymax].join(' ') + ']';
		fdesc.FontBBox = metric.bbox;

		//@param $flags (int) Unsigned 32-bit integer containing flags specifying various characteristics of the font (PDF32000:2008 - 9.8.2 Font Descriptor Flags): +1 for fixed font; +4 for symbol or +32 for non-symbol; +64 for italic. Fixed and Italic mode are generally autodetected so you have to set it to 32 = non-symbolic font (default) or 4 = symbolic font.
		metric.flags = 32;
		var macStyle = await ro.ushort(fb, o); o += 2;
		if ((macStyle & 2) == 2) metric.flags |= 64;
		fdesc.Flags = metric.flags;

		o = tables['OS/2'].offset + 2;
		metric.avgWidth = await ro.short(fb, o); o += 2;
		fdesc.AvgWidth = metric.avgWidth;
		var wtClass = await ro.ushort(fb, o); o += 2;
		metric.stemV = Math.round(70 * wtClass / 400);
		fdesc.StemV = metric.stemV;
		metric.stemH = Math.round(30 * wtClass / 400);
		fdesc.StemH = metric.stemH;
		o += 2;
		metric.restricted = (await ro.short(fb, o) == 2);

		o = tables.post.offset + 4;
		metric.italicAngle = await ro.fixed(fb, o); o += 4;
		fdesc.ItalicAngle = metric.italicAngle;
		metric.ulinePos = await ro.short(fb, o) * urk; o += 2;
		metric.ulineThick = await ro.short(fb, o) * urk; o += 2;
		if (await await ro.ulong(fb, o) != 0) metric.flags |= 1;

		o = tables.hhea.offset + 4;
		metric.ascent = await ro.short(fb, o) * urk; o += 2;
		fdesc.Ascent = metric.ascent;
		metric.descent = await ro.short(fb, o) * urk; o += 2;
		fdesc.Descent = metric.descent;
		metric.leading = await ro.short(fb, o) * urk; o += 2;
		fdesc.Leading = metric.leading;
		metric.maxWidth = await ro.short(fb, o) * urk; o += 2;
		fdesc.MaxWidth = metric.maxWidth;
		o += 22;
		metric.numOfHMetrics = await ro.ushort(fb, o);

		o = tables.maxp.offset + 4;
		metric.numGlyphs = await ro.ushort(fb, o);

		await this.getGlyphInfo();

		await this.getFontName();

		await this.getCIDtoGIDMap()

		await this.getSize();

		await this.getGPOS();
	},
	getTables: async function () {
		var fb = this.fb;
		var numTables = await ro.ushort(fb, 4);
		var tables = {};
		for (var i = 0; i < numTables; i++) {
			var o = 12 + i * 16;
			var tag = await ro.substr(fb, o + 0, 4);
			tables[tag] = {
				checksum: await ro.ulong(fb, o + 4),
				offset: await ro.ulong(fb, o + 8),
				length: await ro.ulong(fb, o + 12)
			};
		}
		this.d.tables = tables;
	},
	getGlyphInfo: async function () {
		var tables = this.d.tables;
		var fb = this.fb;
		var o = tables.head.offset + 50;
		var offSize = (await ro.short(fb, o) == 0 ? 2 : 4); o += 2;
		this.d.offSize = offSize;
		var ufn = offSize == 2 ? async (fb, o) => { return await ro.ushort(fb, o) * 2; } : ro.ulong;
		var iToLoc = [];
		var count = Math.floor(tables.loca.length / 2);
		o = tables.loca.offset;
		for (var i = 0; i < count; i++) {
			iToLoc[i] = await ufn(fb, o);
			if (typeof (iToLoc[i - 1]) != 'undefined' && iToLoc[i] == iToLoc[i - 1])
				delete (iToLoc[i - 1]);
			o += offSize;
		}
		this.d.glyphs = {};
		this.d.glyphs.offset = iToLoc;

		var encTbl = [];
		o = tables.cmap.offset + 2;
		count = await ro.ushort(fb, o); o += 2;
		for (i = 0; i < count; i++) {
			encTbl.push({
				platformID: await ro.ushort(fb, o),
				encodingID: await ro.ushort(fb, o + 2),
				offset: await ro.ulong(fb, o + 4)
			});
			o += 8;
		}
		this.d.glyphs.encTables = encTbl;
	},
	getFontName: async function () {
		var fb = this.fb;
		var tables = this.d.tables;
		var metric = this.d.metric;
		var o = tables.name.offset + 2;
		var count = await ro.ushort(fb, o); o += 2;
		var strStO = await ro.ushort(fb, o); o += 2;
		for (var i = 0; i < count; i++) {
			o += 6;
			var nameID = await ro.ushort(fb, o); o += 2;
			if (nameID == 6) {
				var strLen = await ro.ushort(fb, o); o += 2;
				var strO = await ro.ushort(fb, o);
				o = tables.name.offset + strStO + strO;
				var name = await ro.substr(fb, o, strLen);
				metric.nameO = name
				metric.name = name.replace(/[^a-z0-9]/ig, '');
				break;
			} else o += 4;
		}
	},
	getCIDtoGIDMap: async function () {
		var fb = this.fb;
		var tables = this.d.tables;
		var ctg = {};
		if (this.isPc) {
			var platid = 3, encid = 1; // pc
		} else {
			platid = 1, encid = 0; // mac
		}
		var gl = this.d.glyphs;
		for (var i = 0; i < gl.encTables.length; i++) {
			var encTbl = gl.encTables[i];
			if (encTbl.platformID == platid && encTbl.encodingID == encid) {
				var o = tables.cmap.offset + encTbl.offset;
				var format = await ro.ushort(fb, o); o += 2;
				switch (format) {
					case 0:
						o += 4;
						for (var c = 0; c < 256; c++) {
							ctg[c] = await ro.ubyte(fb, o);
							o++;
						}
						break;
					case 2:
						this.log('unhandled CIDtoGID format: ' + format);
						// todo add high-byte mapping through table
						break;
					case 4:
						var length = await ro.ushort(fb, o); o += 4;
						var segCnt = Math.floor(await ro.ushort(fb, o) / 2); o += 8;
						var endCnt = [];
						for (var k = 0; k < segCnt; k++) {
							endCnt[k] = await ro.ushort(fb, o); o += 2;
						}
						o += 2;
						var startCnt = [];
						for (var k = 0; k < segCnt; k++) {
							startCnt[k] = await ro.ushort(fb, o); o += 2;
						}
						var idDelta = [];
						for (var k = 0; k < segCnt; k++) {
							idDelta[k] = await ro.ushort(fb, o); o += 2;
						}
						var idRangeOffset = [];
						for (var k = 0; k < segCnt; k++) {
							idRangeOffset[k] = await ro.ushort(fb, o); o += 2;
						}
						var gidLen = Math.floor(length / 2) - 8 - (4 * segCnt);
						var glyphIdx = [];
						for (var k = 0; k < gidLen; k++) {
							glyphIdx[k] = await ro.ushort(fb, o); o += 2;
						}
						for (var k = 0; k < segCnt; k++) {
							for (var c = startCnt[k]; c <= endCnt[k]; c++) {
								if (idRangeOffset[k] == 0)
									var g = (idDelta[k] + c) % 65536;
								else {
									var gid = Math.floor(idRangeOffset[k] / 2) + (c - startCnt[k]) - (segCnt - k);
									var g = (glyphIdx[gid] + idDelta[k]) % 65536;
								}
								if (g < 0) g = 0;
								if (!isNaN(g))
									ctg[c] = g;
							}
						}
						break;

					case 6:
					case 8:
					case 10:
					case 12:
					case 13:
					case 14:
						this.log('unhandled CIDtoGID format: ' + format);
						break;
				}
			}
		}
		if (typeof ctg[0] == 'undefined') ctg[0] = 0;
		gl.ctgFormat = format;
		gl.ctg = ctg;
		gl.gtc = this.flip(ctg);
	},
	getSize: async function () {
		var fb = this.fb;
		var tables = this.d.tables;
		var m = this.d.metric;
		var gl = this.d.glyphs;
		if (typeof tables.glyf == 'undefined') return;

		var o = tables.glyf.offset + gl.offset[gl.ctg[120]] + 4;
		yMin = await ro.short(fb, o); o += 4;
		yMax = await ro.short(fb, o); o += 2;
		m.xheight = Math.round((yMax - yMin) * m.urk);
		this.d.fdesc.XHeight = m.xheight;

		var o = tables.glyf.offset + gl.offset[gl.ctg[72]] + 4;
		yMin = await ro.short(fb, o); o += 4;
		yMax = await ro.short(fb, o); o += 2;
		m.capheight = Math.round((yMax - yMin) * m.urk);
		this.d.fdesc.CapHeight = m.capheight;

		var gw = {};
		o = tables.hmtx.offset;
		for (var i = 0; i < m.numGlyphs; i++) {
			if (i < m.numOfHMetrics) {
				gw[i] = Math.round(await ro.ushort(fb, o) * m.urk); o += 4;
			} else
				gw[i] = gw[m.numOfHMetrics - 1];
		}

		m.missingWidth = gw[0];
		this.d.fdesc.MissingWidth = m.missingWidth;

		m.cbbox = '';
		var cw = {};
		var keys = Object.keys(gl.ctg);
		for (var i = 0; i < keys.length; i++) {
			var cid = keys[i];
			if (this.isset(gw, gl.ctg[cid]))
				cw[cid] = gw[gl.ctg[cid]];
			// if add_cbbox...
		}

		gl.cw = cw;
	},
	getGPOS: async function () {
		var fb = this.fb;
		var tables = this.d.tables;
		var gl = this.d.glyphs;
		if (typeof tables.GPOS == 'undefined') return;
		var gpos = tables.GPOS;
		var gp = {};
		var kern = {};
		var o = gpos.offset;
		var offSize = this.d.offSize;
		// seems GPOS offsets are always short, despite setting of indexToLocFormat in head.
		offSize = 2;
		var uint = offSize == 2 ? ro.ushort : ro.ulong;
		gp.ver = await ro.ulong(fb, o); o += 4;
		gp.slo = await uint(fb, o); o += offSize; // script list, may not need
		gp.flo = await uint(fb, o); o += offSize; // feature list, may not need
		gp.llo = await uint(fb, o); o += offSize; // lookup list

		o = gpos.offset + gp.llo;
		gp.llc = await ro.ushort(fb, o); o += 2;
		for (var i = 0; i < gp.llc; i++) {
			var lo = await uint(fb, o); o += offSize;
			var o2 = gpos.offset + gp.llo + lo;
			var ltype = await ro.ushort(fb, o2); o2 += 2;
			if (ltype != 2) continue; // proceed only if KERN
			var lflag = await ro.ushort(fb, o2); o2 += 2;
			var subcnt = await ro.ushort(fb, o2); o2 += 2;
			for (var j = 0; j < subcnt; j++) {
				var subo = await uint(fb, o2); o2 += offSize;
				var o3 = gpos.offset + gp.llo + lo + subo;

				var posFormat = await ro.ushort(fb, o3); o3 += 2;
				var offCoverage = await uint(fb, o3); o3 += offSize;
				var valFormat1 = await ro.ushort(fb, o3); o3 += 2;
				var valFormat2 = await ro.ushort(fb, o3); o3 += 2;

				if (posFormat == 1) {
					this.log('GPOS format 1 not supported');
					var pairSetCount = await ro.ushort(fb, o3); o3 += 2;
					for (var k = 0; k < pairSetCount; k++) {
						var pairSetOffset = await uint(fb, o3); o3 += offSize;
						var o4 = gpos.offset + gp.llo + lo + subo + pairSetOffset;
						var pairValueCount = await ro.ushort(fb, o4); o4 += 2;
						for (var x = 0; x < pairValueCount; x++) {
							var glyph2 = await ro.ushort(fb, o4); o4 += 2;
							var val1 = await ro.ushort(fb, o4); o4 += 2;
							if (valFormat2 > 0) {
								var val2 = await ro.ushort(fb, o4); o4 += 2;
							}
						}
					}
				} else if (posFormat == 2) {
					var oClDef1 = await uint(fb, o3); o3 += offSize;
					var oClDef2 = await uint(fb, o3); o3 += offSize;
					var cl1cnt = await ro.ushort(fb, o3); o3 += 2;
					var cl2cnt = await ro.ushort(fb, o3); o3 += 2;
					var o4 = gpos.offset + gp.llo + lo + subo + oClDef1;
					var cl1 = await this.classPairTable(fb, o4);
					var o4 = gpos.offset + gp.llo + lo + subo + oClDef2;
					var cl2 = await this.classPairTable(fb, o4);

					for (var x = 0; x < cl1cnt; x++) {
						for (var y = 0; y < cl2cnt; y++) {
							var val1 = await ro.short(fb, o3); o3 += 2;
							if (valFormat2 > 0) {
								var val2 = await ro.short(fb, o3); o3 += 2;
								if (this.isset(cl1, x) && this.isset(cl2, y))
									this.log('valformat2>0 is not supported: [(' + x + ',' + y + ')(' + val1 + ',' + val2 + ')]');
							} else {
								if (this.isset(cl1, x) && this.isset(cl2, y) && val1 != 0) {
									for (var a = 0; a < cl1[x].length; a++) {
										var g1 = cl1[x][a];
										for (var b = 0; b < cl2[y].length; b++) {
											var g2 = cl2[y][b];
											this.setd(kern, gl.gtc[g1], gl.gtc[g2], val1);
										}
									}
								}
							}
						}
					}

				} else this.log('PosFormat ' + posFormat + ' is not yet implemented');

			}
		}

		this.d.gpos = gp;
		this.d.kern = kern;
	},
	classPairTable: async function (fb, o) {
		var cl = {};
		var fmt = await ro.ushort(fb, o); o += 2;
		if (fmt == 1) {
			var gl1 = await ro.ushort(fb, o); o += 2;
		}
		cnt = await ro.ushort(fb, o); o += 2;
		for (var x = 0; x < cnt; x++) {
			if (fmt == 1) {
				var glcv = await ro.ushort(fb, o); o += 2;
				if (!Array.isArray(cl[glcv])) cl[glcv] = [];
				cl[glcv].push(gl1);
				gl1++;
			} else {
				var gla = await ro.ushort(fb, o); o += 2;
				var glb = await ro.ushort(fb, o); o += 2;
				var glcv = await ro.ushort(fb, o); o += 2;
				for (var y = gla; y <= glb; y++) {
					if (!Array.isArray(cl[glcv])) cl[glcv] = [];
					cl[glcv].push(y);
				}
			}
		}
		return cl;
	},
	isset: function (obj, key) {
		if (typeof obj !== 'object') return false;
		return (key in obj);
	},
	setd: function () {
		if (arguments.length < 3) return;
		var obj = arguments[0];
		if (typeof obj !== 'object') return;
		var nobj = obj;
		var key = null;
		for (var x = 1; x < arguments.length - 1; x++) {
			key = arguments[x];
			if (typeof nobj[key] === 'undefined') nobj[key] = {};
			if (x < arguments.length - 2) nobj = nobj[key];
		}
		nobj[key] = arguments[x];
	},
	flip: function (o) {
		if (typeof o !== 'object') return o;
		var retval = {};
		for (var k in o) {
			var v = o[k];
			if (/^[0-9]*$/.test(k)) k = parseInt(k);
			retval[v] = k;
		}
		return retval;
	}
});

var x = module.exports = {
	parse: async (ttfile) => {
		var data = {
			fname: ptool.parse(ptool.resolve(ttfile))
		};
		var log = function () {
			if (!Array.isArray(data.log)) data.log = [];
			var a = [].slice.call(arguments);
			data.log.push(a.join(' '));
		}
		const fd = await fopen(ttfile, 'r');
		var lstat = fs.lstatSync(ttfile);
		var size = lstat.size;
		if (debug) log('opening ' + ttfile, size);
		//console.log(ttfile, size);
		var ttf = clttf();
		if (await ro.ulong(fd, 0) == 0x00010000) {

			ttf.fb = fd;
			ttf.log = log;
			await ttf.parseTTF(fd);
			data.metric = ttf.d.metric;
			data.fdesc = ttf.d.fdesc;
			data.cw = ttf.d.glyphs.cw;
			data.kern = ttf.d.kern;
			data.ctg = ttf.d.glyphs.ctg;
			data.fname.blength = size;

			data.raw = async (rawType) => {
				const fd = await fopen(ttfile, 'r');
				const buff = await ro.getBuff(fd, 0, size);
				let raw = '';
				if (rawType & x.ZLIB) {
					raw = zlib.deflateRawSync(buff);
					data.fname.zlength = raw.length;
				}
				else raw = buff;

				if (rawType & x.B85) {
					raw = b85.encode(raw, 'ascii85');
					data.fname.b85length = raw.length;
				} else if (rawType & x.B64) {
					raw = raw.toString('base64');
					data.fname.b64length = raw.length;
				} else {
					raw = raw.toString('binary');
				}
				return raw;
			}
			return data;
		}
		else log('not a ttf file');
		return null;
	},
	ZLIB: 1, B85: 2, B64: 4,
	stringify: (obj, replacer, i) => {
		var json = JSON.stringify(obj, replacer, i);
		var w = process.stdout.columns;
		w = 80;
		if (typeof json === 'string') {
			var strout = '';
			var strtmp = '';
			var lstind = 0;
			var bufout = [];
			var ja = json.split(/[\r\n]+/);

			for (var i = 0; i < ja.length; i++) {
				var rxl = ja[i].match(/^(\s*)([^\s].*)$/);
				var ind = rxl[1].length;
				var ws = rxl[1];
				if (ind != lstind || (strtmp.length + rxl[2].length + 1) > w) {
					strout += strtmp + '\n';
					strtmp = '';
				} else if (ind == lstind) ws = ' ';
				strtmp += ws + rxl[2];
				lstind = ind;
			}
			strout += strtmp;
			json = strout;
		}
		return json;
	},
	save: async function (fname, data) {
		if (!fname) fname = ptool.join(data.fname.dir, data.fname.name + '.json');
		if (!ptool.isAbsolute(fname))
			fname = ptool.join(__dirname, fname);
		var contents = data;
		if (typeof data === 'object')
			contents = this.stringify(data, null, 2);
		return writeFile(fname, contents);
	},
	cidinit: async () => {
		var fn = ptool.join(__dirname, 'ttf_cidinit.txt');
		return readFile(fn);
	}
};


