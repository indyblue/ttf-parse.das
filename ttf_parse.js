var fs = require('fs');
var path = require('path');
var b85 = require('base85');
//var lzw = require("node-lzw");
var zlib = require('zlib');

var debug = true;

var ro = {
	ulong: function(fd, offset, cb){
		if(Buffer.isBuffer(fd)) return fd.readUInt32BE(offset);
		else this.getBuff(fd, offset, 4, (b)=> { cb(b.readUInt32BE(0)); } ); 
	},
	ushort: function(fd, offset, cb){
		if(Buffer.isBuffer(fd)) {
			//console.log(fd.length, offset);
			return fd.readUInt16BE(offset);
		}
		else this.getBuff(fd, offset, 2, (b)=> { cb(b.readUInt16BE(0)); } ); 
	},
	ubyte: function(fd, offset, cb){
		if(Buffer.isBuffer(fd)) return fd.readUInt8(offset);
		else this.getBuff(fd, offset, 1, (b)=> { cb(b.readUInt8(0)); } ); 
	},
	short: function(fd, offset, cb){
		if(Buffer.isBuffer(fd)) return fd.readInt16BE(offset);
		else this.getBuff(fd, offset, 2, (b)=> { cb(b.readInt16BE(0)); } ); 
	},
	fixed: function(fd, offset, cb){
		if(Buffer.isBuffer(fd)) 
			return parseFloat(''+fd.readInt16BE(offset)+'.'+fd.readUInt16BE(offset+2));
		else this.getBuff(fd, offset, 4, (b)=> { 
			cb(parseFloat(''+b.readInt16BE(0)+'.'+b.readUInt16BE(2)));
		} ); 
	},
	substr: function(fd, offset, length, cb){
		if(Buffer.isBuffer(fd)) return fd.toString('utf8',offset,offset+length);
		else this.getBuff(fd, offset, length, (b)=> { cb(b.toString()); } ); 
	},
	getBuff: function(fd, offset, length, cb) {
		var buff = new Buffer(length);
		fs.read(fd, buff, 0, length, offset, function(err, bytesRead, buff){
			cb(buff);
		});
	}
};

var clttf = function() {
	return {
		isPc: true,
		fb: null,
		d: {},
		parseTTF: function() {
			var fb = this.fb;
			this.getTables();
			var tables = this.d.tables;
			
			//magic number check
			var o = tables.head.offset + 12;
			var magic = ro.ulong(fb, o);
			if(debug) this.log('magic 0x' + magic.toString(16) +' == 0x5f0f3cf5');
			if(magic != 0x5F0F3CF5) return false;

			//get metrics
			var metric = {};
			var fdesc = {};
			this.d.metric = metric;
			this.d.fdesc = fdesc;
			o+=6;
			metric.unitsPerEm = ro.ushort(fb, o);
			var urk = 1000 / metric.unitsPerEm;
			metric.urk = urk;
			o+=18;
			var xmin = Math.round(ro.short(fb, o) * urk); o+=2;
			var ymin = Math.round(ro.short(fb, o) * urk); o+=2;
			var xmax = Math.round(ro.short(fb, o) * urk); o+=2;
			var ymax = Math.round(ro.short(fb, o) * urk); o+=2;
			metric.bbox = '['+[xmin, ymin, xmax, ymax].join(' ')+']';
			fdesc.FontBBox = metric.bbox;

			//@param $flags (int) Unsigned 32-bit integer containing flags specifying various characteristics of the font (PDF32000:2008 - 9.8.2 Font Descriptor Flags): +1 for fixed font; +4 for symbol or +32 for non-symbol; +64 for italic. Fixed and Italic mode are generally autodetected so you have to set it to 32 = non-symbolic font (default) or 4 = symbolic font.
			metric.flags = 32;
			var macStyle = ro.ushort(fb, o); o+=2;
			if((macStyle&2)==2) metric.flags |= 64;
			fdesc.Flags=metric.flags;

			o = tables['OS/2'].offset + 2;
			metric.avgWidth = ro.short(fb, o); o+=2;
			fdesc.AvgWidth = metric.avgWidth;
			var wtClass = ro.ushort(fb, o); o+=2;
			metric.stemV = Math.round(70*wtClass/400);
			fdesc.StemV = metric.stemV;
			metric.stemH = Math.round(30*wtClass/400);
			fdesc.StemH = metric.stemH;
			o+=2;
			metric.restricted = (ro.short(fb, o)==2);

			o = tables.post.offset + 4;
			metric.italicAngle = ro.fixed(fb, o); o+=4;
			fdesc.ItalicAngle  = metric.italicAngle;
			metric.ulinePos = ro.short(fb, o) * urk; o+=2;
			metric.ulineThick = ro.short(fb, o) * urk; o+=2;
			if(ro.ulong(fb, o)!=0) metric.flags |= 1;

			o = tables.hhea.offset + 4;
			metric.ascent = ro.short(fb, o)*urk; o+=2;
			fdesc.Ascent = metric.ascent;
			metric.descent = ro.short(fb, o)*urk; o+=2;
			fdesc.Descent = metric.descent;
			metric.leading = ro.short(fb, o)*urk; o+=2;
			fdesc.Leading = metric.leading;
			metric.maxWidth = ro.short(fb, o)*urk; o+=2;
			fdesc.MaxWidth = metric.maxWidth;
			o+=22;
			metric.numOfHMetrics = ro.ushort(fb, o);

			o = tables.maxp.offset + 4;
			metric.numGlyphs = ro.ushort(fb, o);

			this.getGlyphInfo();
			
			this.getFontName();

			this.getCIDtoGIDMap()

			this.getSize();

			this.getGPOS();

		},
		getTables: function() {
			var fb = this.fb;
			var numTables = ro.ushort(fb, 4);
			var tables = {};
			for(var i=0;i<numTables;i++){
				var o = 12+i*16;
				var tag = ro.substr(fb, o+0, 4);
				tables[tag] = {
					checksum: ro.ulong(fb, o+4),
					offset: ro.ulong(fb, o+8),
					length: ro.ulong(fb, o+12)
				};
			}
			this.d.tables = tables;
		},
		getGlyphInfo: function() {
			var tables = this.d.tables;
			var fb = this.fb;
			var o = tables.head.offset + 50;
			var offSize = (ro.short(fb, o)==0 ? 2 : 4); o+=2;
			this.d.offSize = offSize;
			var ufn = offSize==2 ? (fb, o)=> { return ro.ushort(fb, o) *2;} : ro.ulong;
			var iToLoc = [];
			var count = Math.floor(tables.loca.length/2);
			o = tables.loca.offset;
			for(var i=0;i<count;i++){
				iToLoc[i] = ufn(fb, o);
				if(typeof(iToLoc[i-1])!='undefined' && iToLoc[i] == iToLoc[i-1])
					delete(iToLoc[i-1]);
				o+= offSize;
			}
			this.d.glyphs = {};
			this.d.glyphs.offset = iToLoc;

			var encTbl = [];
			o = tables.cmap.offset+2;
			count = ro.ushort(fb, o); o+=2;
			for(i=0;i<count;i++){
				encTbl.push({
					platformID: ro.ushort(fb, o),
					encodingID: ro.ushort(fb, o+2),
					offset: ro.ulong(fb, o+4)
				});
				o+=8;
			}
			this.d.glyphs.encTables = encTbl;

		},
		getFontName: function() {
			var fb = this.fb;
			var tables = this.d.tables;
			var metric = this.d.metric;
			var o = tables.name.offset+2;
			var count = ro.ushort(fb, o); o+=2;
			var strStO = ro.ushort(fb, o); o+=2;
			for(var i=0;i<count;i++){
				o+=6;
				var nameID = ro.ushort(fb, o); o+=2;
				if(nameID==6) {
					var strLen = ro.ushort(fb, o); o+=2;
					var strO = ro.ushort(fb, o);
					o = tables.name.offset + strStO + strO;
					var name = ro.substr(fb, o, strLen);
					metric.nameO = name
					metric.name = name.replace(/[^a-z0-9]/ig, '');
					break;
				} else o+=4;
			}
		},
		getCIDtoGIDMap: function() {
			var fb = this.fb;
			var tables = this.d.tables;
			var ctg = {};
			if(this.isPc){
				var platid = 3, encid = 1; // pc
			} else {
				platid = 1, encid = 0; // mac
			}
			var gl = this.d.glyphs;
			for(var i = 0; i<gl.encTables.length; i++) {
				var encTbl = gl.encTables[i];
				if(encTbl.platformID==platid && encTbl.encodingID==encid){
					var o = tables.cmap.offset + encTbl.offset;
					var format = ro.ushort(fb, o); o+=2;
					switch(format){
						case 0:
							o+=4;
							for(var c=0;c<256;c++) {
								ctg[c] = ro.ubyte(fb, o);
								o++;
							}
							break;
						case 2:
							this.log('unhandled CIDtoGID format: '+format);
							// todo add high-byte mapping through table
							break;
						case 4:
							var length = ro.ushort(fb, o); o+=4;
							var segCnt = Math.floor(ro.ushort(fb, o)/2); o+=8;
							var endCnt = [];
							for(var k=0;k<segCnt;k++){
								endCnt[k] = ro.ushort(fb, o); o+=2;
							}
							o+=2;
							var startCnt = [];
							for(var k=0;k<segCnt;k++){
								startCnt[k] = ro.ushort(fb, o); o+=2;
							}
							var idDelta = [];
							for(var k=0;k<segCnt;k++){
								idDelta[k] = ro.ushort(fb, o); o+=2;
							}
							var idRangeOffset = [];
							for(var k=0;k<segCnt;k++){
								idRangeOffset[k] = ro.ushort(fb, o); o+=2;
							}
							var gidLen = Math.floor(length/2)-8-(4*segCnt);
							var glyphIdx = [];
							for(var k=0;k<gidLen;k++){
								glyphIdx[k] = ro.ushort(fb, o); o+=2;
							}
							for(var k=0;k<segCnt;k++){
								for(var c=startCnt[k]; c<=endCnt[k];c++){
									if(idRangeOffset[k]==0)
										var g=(idDelta[k]+c)%65536;
									else {
										var gid = Math.floor(idRangeOffset[k]/2) + (c-startCnt[k]) - (segCnt-k);
										var g = (glyphIdx[gid] + idDelta[k]) % 65536;
									}
									if(g<0) g=0;
									if(!isNaN(g)) 
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
							this.log('unhandled CIDtoGID format: '+format);
							break;
					}
				}
			}
			if(typeof ctg[0] == 'undefined') ctg[0]=0;
			gl.ctgFormat = format;
			gl.ctg = ctg;
			gl.gtc = this.flip(ctg);
		},
		getSize: function() {
			var fb = this.fb;
			var tables = this.d.tables;
			var m = this.d.metric;
			var gl = this.d.glyphs;
			if(typeof tables.glyf=='undefined') return;

			var o = tables.glyf.offset + gl.offset[gl.ctg[120]] + 4;
			yMin = ro.short(fb, o); o+=4;
			yMax = ro.short(fb, o); o+=2;
			m.xheight = Math.round((yMax-yMin)*m.urk);
			this.d.fdesc.XHeight = m.xheight;

			var o = tables.glyf.offset + gl.offset[gl.ctg[72]] + 4;
			yMin = ro.short(fb, o); o+=4;
			yMax = ro.short(fb, o); o+=2;
			m.capheight = Math.round((yMax-yMin)*m.urk);
			this.d.fdesc.CapHeight = m.capheight;

			var gw = {};
			o = tables.hmtx.offset;
			for(var i=0; i<m.numGlyphs; i++) {
				if(i<m.numOfHMetrics) {
					gw[i] = Math.round(ro.ushort(fb, o)*m.urk); o+=4;
				} else
					gw[i] = gw[m.numOfHMetrics-1];
			}

			m.missingWidth = gw[0];
			this.d.fdesc.MissingWidth = m.missingWidth;
			
			m.cbbox = '';
			var cw = {};
			var keys = Object.keys(gl.ctg);
			for(var i=0; i<keys.length; i++){
				var cid = keys[i];
				if(this.isset(gw,gl.ctg[cid]))
					cw[cid] = gw[gl.ctg[cid]];
				// if add_cbbox...
			}

			gl.cw = cw;
		},
		getGPOS: function() {
			var fb = this.fb;
			var tables = this.d.tables;
			var gl = this.d.glyphs;
			if(typeof tables.GPOS=='undefined')	return;
			var gpos = tables.GPOS;
			var gp = {};
			var kern = {};
			var o = gpos.offset;
			var offSize = this.d.offSize;
			// seems GPOS offsets are always short, despite setting of indexToLocFormat in head.
			offSize = 2; 
			var uint = offSize==2 ? ro.ushort : ro.ulong;
			gp.ver = ro.ulong(fb, o); o+=4;
			gp.slo = uint(fb, o); o+=offSize; // script list, may not need
			gp.flo = uint(fb, o); o+=offSize; // feature list, may not need
			gp.llo = uint(fb, o); o+=offSize; // lookup list

			o = gpos.offset + gp.llo;
			gp.llc = ro.ushort(fb, o); o+=2;
			for(var i=0;i<gp.llc;i++){
				var lo = uint(fb, o); o+=offSize;
				var o2 = gpos.offset + gp.llo + lo;
				var ltype = ro.ushort(fb, o2); o2+=2;
				if(ltype!=2) continue; // proceed only if KERN
				var lflag = ro.ushort(fb, o2); o2+=2;
				var subcnt = ro.ushort(fb, o2); o2+=2;
				for(var j=0;j<subcnt;j++){
					var subo = uint(fb, o2); o2+=offSize;
					var o3 = gpos.offset + gp.llo + lo + subo;
					
					var posFormat = ro.ushort(fb, o3); o3+=2;
					var offCoverage = uint(fb, o3); o3+=offSize;
					var valFormat1 = ro.ushort(fb, o3); o3+=2;
					var valFormat2 = ro.ushort(fb, o3); o3+=2;

					if(posFormat==1) {
						this.log('GPOS format 1 not supported');
						var pairSetCount = ro.ushort(fb, o3); o3+=2;
						for(var k=0; k<pairSetCount; k++){
							var pairSetOffset = uint(fb, o3); o3+=offSize;
							var o4 = gpos.offset + gp.llo + lo + subo + pairSetOffset;
							var pairValueCount = ro.ushort(fb, o4); o4+=2;
							for(var x=0; x<pairValueCount; x++) {
								var glyph2 = ro.ushort(fb, o4); o4+=2;
								var val1 = ro.ushort(fb, o4); o4+=2;
								if(valFormat2>0) {
									var val2 = ro.ushort(fb, o4); o4+=2;
								}
							}
						}
					} else if(posFormat == 2) {
						var oClDef1 = uint(fb, o3); o3+=offSize;
						var oClDef2 = uint(fb, o3); o3+=offSize;
						var cl1cnt = ro.ushort(fb, o3); o3+=2;
						var cl2cnt = ro.ushort(fb, o3); o3+=2;
						var o4 = gpos.offset + gp.llo + lo + subo + oClDef1;
						var cl1 = this.classPairTable(fb, o4);
						var o4 = gpos.offset + gp.llo + lo + subo + oClDef2;
						var cl2 = this.classPairTable(fb, o4);

						for(var x=0; x<cl1cnt; x++) {
							for(var y=0; y<cl2cnt; y++) {
								var val1 = ro.short(fb, o3); o3+=2;
								if(valFormat2>0) {
									var val2 = ro.short(fb, o3); o3+=2;
									if(this.isset(cl1,x) && this.isset(cl2,y))
										this.log('valformat2>0 is not supported: [('+x+','+y+')('+val1+','+val2+')]');
								} else {
									if(this.isset(cl1,x) && this.isset(cl2,y) && val1!=0) {
										for(var a=0; a<cl1[x].length; a++) {
											var g1 = cl1[x][a];
											for(var b=0; b<cl2[y].length; b++) {
												var g2 = cl2[y][b];
												this.setd(kern,gl.gtc[g1],gl.gtc[g2],val1);
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
		classPairTable(fb, o) {
			var cl = {};
			var fmt = ro.ushort(fb, o); o+=2;
			if(fmt==1) {
				var gl1 = ro.ushort(fb, o); o+=2;
			}
			cnt = ro.ushort(fb, o); o+=2;
			for(var x=0; x<cnt; x++){
				if(fmt==1) {
					var glcv = ro.ushort(fb, o); o+=2;
					if(!Array.isArray(cl[glcv])) cl[glcv] = [];
					cl[glcv].push(gl1);
					gl1++;
				} else {
					var gla = ro.ushort(fb, o); o+=2;
					var glb = ro.ushort(fb, o); o+=2;
					var glcv = ro.ushort(fb, o); o+=2;
					for(var y=gla; y<=glb; y++) {
						if(!Array.isArray(cl[glcv])) cl[glcv] = [];
						cl[glcv].push(y);
					}
				}
			}
			return cl;
		},
		isset: function(obj, key) {
			if(typeof obj!=='object') return false;
			var keys = Object.keys(obj);
			return keys.indexOf(key) >= 0
				|| keys.indexOf(key.toString()) >=0;
		},
		setd: function() {
			if(arguments.length<3) return;
			var obj = arguments[0];
			if(typeof obj !== 'object') return;
			var nobj = obj;
			var key = null;
			for(var x=1;x<arguments.length-1; x++) {
				key = arguments[x];
				if(typeof nobj[key] === 'undefined') nobj[key] = {};
				if(x<arguments.length-2) nobj = nobj[key];
			}
			nobj[key] = arguments[x];
		},
		flip: function(o) {
			if(typeof o !=='object') return o;
			var keys = Object.keys(o);
			var retval = {};
			for(var i=0;i<keys.length;i++){
				var k = keys[i];
				var v = o[k];
				if(/^[0-9]*$/.test(k)) k = parseInt(k);
				retval[v] = k;
			}
			return retval;
		}
	};
};

var x = module.exports = {
	parse: function(ttfile, cb) {
		var data = { 
			fname: path.parse(path.resolve(ttfile))
		};
		var log = function() {
			if(!Array.isArray(data.log)) data.log = [];
			var a = [].slice.call(arguments);
			data.log.push(a.join(' '));
		}
		fs.open(ttfile, 'r', function(err, fd){
			var lstat = fs.lstatSync(ttfile);
			var size = lstat.size;
			if(debug) log('opening '+ttfile, size);
			if(err) log(JSON.stringify(err));
			ro.getBuff(fd, 0, size, (fb)=>{
				console.log(ttfile, size);
				var ttf = new clttf();
				ttf.fb = fb;
				if(ro.ulong(fb, 0) == 0x00010000) {
					
					ttf.log = log;
					ttf.parseTTF(fb);
					data.metric = ttf.d.metric;
					data.fdesc = ttf.d.fdesc;
					data.cw = ttf.d.glyphs.cw;
					data.kern = ttf.d.kern;
					data.ctg = ttf.d.glyphs.ctg;
					data.fname.blength = fb.length;

					data.raw = fb.toString('binary');
						//.replace(/(.{80})/g, '$1\n');;

					//var fb_zip = zlib.deflateRawSync(fb);
					//data.fname.zlength = fb_zip.length;

					//var fb85 = b85.encode(fb_zip, 'ascii85');
						//.replace(/(.{80})/g, '$1\n');
					//data.fname.a85length = fb85.length;

					//data.ttf85 = fb85

					cb(data);
				}
				else log('not a ttf file');
			});
		});
	},
	stringify: function(obj, replacer, i){
		var json = JSON.stringify(obj, replacer, i);
		var w = process.stdout.columns;
		w=80;
		if(typeof json === 'string') {
			var strout = '';
			var strtmp = '';
			var lstind = 0;
			var bufout = [];
			var ja = json.split(/[\r\n]+/);

			for(var i=0; i<ja.length; i++) {
				var rxl = ja[i].match(/^(\s*)([^\s].*)$/);
				var ind = rxl[1].length;
				var ws = rxl[1];
				if(ind!=lstind || (strtmp.length+rxl[2].length+1) > w) {
					strout += strtmp + '\n';
					strtmp = '';
				} else if(ind==lstind) ws = ' ';
				strtmp += ws + rxl[2];
				lstind = ind;
			}
			json = strout;
		}
		return json;
	},
	save: function(fname, data, cb) {
		if(!fname) fname = path.join(data.fname.dir, data.fname.name + '.json');
		if(!path.isAbsolute(fname))
			fname = path.join(__dirname, fname);
		var contents = data;
		if(typeof data === 'object') 
			contents = this.stringify(data, null, 2);
		fs.writeFile(fname, contents, cb);
	}
};


