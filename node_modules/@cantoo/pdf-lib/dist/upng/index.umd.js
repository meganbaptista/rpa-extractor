"use strict";
var UPNG = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __getOwnPropSymbols = Object.getOwnPropertySymbols;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __propIsEnum = Object.prototype.propertyIsEnumerable;
  var __objRest = (source, exclude) => {
    var target = {};
    for (var prop in source)
      if (__hasOwnProp.call(source, prop) && exclude.indexOf(prop) < 0)
        target[prop] = source[prop];
    if (source != null && __getOwnPropSymbols)
      for (var prop of __getOwnPropSymbols(source)) {
        if (exclude.indexOf(prop) < 0 && __propIsEnum.call(source, prop))
          target[prop] = source[prop];
      }
    return target;
  };
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // index.ts
  var index_exports = {};
  __export(index_exports, {
    compress: () => compress,
    decode: () => decode,
    default: () => index_default,
    dither: () => dither,
    encode: () => encode,
    encodeLL: () => encodeLL,
    quantize: () => quantize,
    toRGBA8: () => toRGBA8
  });

  // ../../../node_modules/fflate/esm/browser.js
  var u8 = Uint8Array;
  var u16 = Uint16Array;
  var i32 = Int32Array;
  var fleb = new u8([
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    1,
    1,
    1,
    1,
    2,
    2,
    2,
    2,
    3,
    3,
    3,
    3,
    4,
    4,
    4,
    4,
    5,
    5,
    5,
    5,
    0,
    /* unused */
    0,
    0,
    /* impossible */
    0
  ]);
  var fdeb = new u8([
    0,
    0,
    0,
    0,
    1,
    1,
    2,
    2,
    3,
    3,
    4,
    4,
    5,
    5,
    6,
    6,
    7,
    7,
    8,
    8,
    9,
    9,
    10,
    10,
    11,
    11,
    12,
    12,
    13,
    13,
    /* unused */
    0,
    0
  ]);
  var clim = new u8([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]);
  var freb = function(eb, start) {
    var b = new u16(31);
    for (var i = 0; i < 31; ++i) {
      b[i] = start += 1 << eb[i - 1];
    }
    var r = new i32(b[30]);
    for (var i = 1; i < 30; ++i) {
      for (var j = b[i]; j < b[i + 1]; ++j) {
        r[j] = j - b[i] << 5 | i;
      }
    }
    return { b, r };
  };
  var _a = freb(fleb, 2);
  var fl = _a.b;
  var revfl = _a.r;
  fl[28] = 258, revfl[258] = 28;
  var _b = freb(fdeb, 0);
  var fd = _b.b;
  var revfd = _b.r;
  var rev = new u16(32768);
  for (i = 0; i < 32768; ++i) {
    x = (i & 43690) >> 1 | (i & 21845) << 1;
    x = (x & 52428) >> 2 | (x & 13107) << 2;
    x = (x & 61680) >> 4 | (x & 3855) << 4;
    rev[i] = ((x & 65280) >> 8 | (x & 255) << 8) >> 1;
  }
  var x;
  var i;
  var hMap = (function(cd, mb, r) {
    var s = cd.length;
    var i = 0;
    var l = new u16(mb);
    for (; i < s; ++i) {
      if (cd[i])
        ++l[cd[i] - 1];
    }
    var le = new u16(mb);
    for (i = 1; i < mb; ++i) {
      le[i] = le[i - 1] + l[i - 1] << 1;
    }
    var co;
    if (r) {
      co = new u16(1 << mb);
      var rvb = 15 - mb;
      for (i = 0; i < s; ++i) {
        if (cd[i]) {
          var sv = i << 4 | cd[i];
          var r_1 = mb - cd[i];
          var v = le[cd[i] - 1]++ << r_1;
          for (var m = v | (1 << r_1) - 1; v <= m; ++v) {
            co[rev[v] >> rvb] = sv;
          }
        }
      }
    } else {
      co = new u16(s);
      for (i = 0; i < s; ++i) {
        if (cd[i]) {
          co[i] = rev[le[cd[i] - 1]++] >> 15 - cd[i];
        }
      }
    }
    return co;
  });
  var flt = new u8(288);
  for (i = 0; i < 144; ++i)
    flt[i] = 8;
  var i;
  for (i = 144; i < 256; ++i)
    flt[i] = 9;
  var i;
  for (i = 256; i < 280; ++i)
    flt[i] = 7;
  var i;
  for (i = 280; i < 288; ++i)
    flt[i] = 8;
  var i;
  var fdt = new u8(32);
  for (i = 0; i < 32; ++i)
    fdt[i] = 5;
  var i;
  var flm = /* @__PURE__ */ hMap(flt, 9, 0);
  var flrm = /* @__PURE__ */ hMap(flt, 9, 1);
  var fdm = /* @__PURE__ */ hMap(fdt, 5, 0);
  var fdrm = /* @__PURE__ */ hMap(fdt, 5, 1);
  var max = function(a) {
    var m = a[0];
    for (var i = 1; i < a.length; ++i) {
      if (a[i] > m)
        m = a[i];
    }
    return m;
  };
  var bits = function(d, p, m) {
    var o = p / 8 | 0;
    return (d[o] | d[o + 1] << 8) >> (p & 7) & m;
  };
  var bits16 = function(d, p) {
    var o = p / 8 | 0;
    return (d[o] | d[o + 1] << 8 | d[o + 2] << 16) >> (p & 7);
  };
  var shft = function(p) {
    return (p + 7) / 8 | 0;
  };
  var slc = function(v, s, e) {
    if (s == null || s < 0)
      s = 0;
    if (e == null || e > v.length)
      e = v.length;
    return new u8(v.subarray(s, e));
  };
  var ec = [
    "unexpected EOF",
    "invalid block type",
    "invalid length/literal",
    "invalid distance",
    "stream finished",
    "no stream handler",
    ,
    // determined by compression function
    "no callback",
    "invalid UTF-8 data",
    "extra field too long",
    "date not in range 1980-2099",
    "filename too long",
    "stream finishing",
    "invalid zip data"
    // determined by unknown compression method
  ];
  var err = function(ind, msg, nt) {
    var e = new Error(msg || ec[ind]);
    e.code = ind;
    if (Error.captureStackTrace)
      Error.captureStackTrace(e, err);
    if (!nt)
      throw e;
    return e;
  };
  var inflt = function(dat, st, buf, dict) {
    var sl = dat.length, dl = dict ? dict.length : 0;
    if (!sl || st.f && !st.l)
      return buf || new u8(0);
    var noBuf = !buf;
    var resize = noBuf || st.i != 2;
    var noSt = st.i;
    if (noBuf)
      buf = new u8(sl * 3);
    var cbuf = function(l2) {
      var bl = buf.length;
      if (l2 > bl) {
        var nbuf = new u8(Math.max(bl * 2, l2));
        nbuf.set(buf);
        buf = nbuf;
      }
    };
    var final = st.f || 0, pos = st.p || 0, bt = st.b || 0, lm = st.l, dm = st.d, lbt = st.m, dbt = st.n;
    var tbts = sl * 8;
    do {
      if (!lm) {
        final = bits(dat, pos, 1);
        var type = bits(dat, pos + 1, 3);
        pos += 3;
        if (!type) {
          var s = shft(pos) + 4, l = dat[s - 4] | dat[s - 3] << 8, t = s + l;
          if (t > sl) {
            if (noSt)
              err(0);
            break;
          }
          if (resize)
            cbuf(bt + l);
          buf.set(dat.subarray(s, t), bt);
          st.b = bt += l, st.p = pos = t * 8, st.f = final;
          continue;
        } else if (type == 1)
          lm = flrm, dm = fdrm, lbt = 9, dbt = 5;
        else if (type == 2) {
          var hLit = bits(dat, pos, 31) + 257, hcLen = bits(dat, pos + 10, 15) + 4;
          var tl = hLit + bits(dat, pos + 5, 31) + 1;
          pos += 14;
          var ldt = new u8(tl);
          var clt = new u8(19);
          for (var i = 0; i < hcLen; ++i) {
            clt[clim[i]] = bits(dat, pos + i * 3, 7);
          }
          pos += hcLen * 3;
          var clb = max(clt), clbmsk = (1 << clb) - 1;
          var clm = hMap(clt, clb, 1);
          for (var i = 0; i < tl; ) {
            var r = clm[bits(dat, pos, clbmsk)];
            pos += r & 15;
            var s = r >> 4;
            if (s < 16) {
              ldt[i++] = s;
            } else {
              var c = 0, n = 0;
              if (s == 16)
                n = 3 + bits(dat, pos, 3), pos += 2, c = ldt[i - 1];
              else if (s == 17)
                n = 3 + bits(dat, pos, 7), pos += 3;
              else if (s == 18)
                n = 11 + bits(dat, pos, 127), pos += 7;
              while (n--)
                ldt[i++] = c;
            }
          }
          var lt = ldt.subarray(0, hLit), dt = ldt.subarray(hLit);
          lbt = max(lt);
          dbt = max(dt);
          lm = hMap(lt, lbt, 1);
          dm = hMap(dt, dbt, 1);
        } else
          err(1);
        if (pos > tbts) {
          if (noSt)
            err(0);
          break;
        }
      }
      if (resize)
        cbuf(bt + 131072);
      var lms = (1 << lbt) - 1, dms = (1 << dbt) - 1;
      var lpos = pos;
      for (; ; lpos = pos) {
        var c = lm[bits16(dat, pos) & lms], sym = c >> 4;
        pos += c & 15;
        if (pos > tbts) {
          if (noSt)
            err(0);
          break;
        }
        if (!c)
          err(2);
        if (sym < 256)
          buf[bt++] = sym;
        else if (sym == 256) {
          lpos = pos, lm = null;
          break;
        } else {
          var add = sym - 254;
          if (sym > 264) {
            var i = sym - 257, b = fleb[i];
            add = bits(dat, pos, (1 << b) - 1) + fl[i];
            pos += b;
          }
          var d = dm[bits16(dat, pos) & dms], dsym = d >> 4;
          if (!d)
            err(3);
          pos += d & 15;
          var dt = fd[dsym];
          if (dsym > 3) {
            var b = fdeb[dsym];
            dt += bits16(dat, pos) & (1 << b) - 1, pos += b;
          }
          if (pos > tbts) {
            if (noSt)
              err(0);
            break;
          }
          if (resize)
            cbuf(bt + 131072);
          var end = bt + add;
          if (bt < dt) {
            var shift = dl - dt, dend = Math.min(dt, end);
            if (shift + bt < 0)
              err(3);
            for (; bt < dend; ++bt)
              buf[bt] = dict[shift + bt];
          }
          for (; bt < end; ++bt)
            buf[bt] = buf[bt - dt];
        }
      }
      st.l = lm, st.p = lpos, st.b = bt, st.f = final;
      if (lm)
        final = 1, st.m = lbt, st.d = dm, st.n = dbt;
    } while (!final);
    return bt != buf.length && noBuf ? slc(buf, 0, bt) : buf.subarray(0, bt);
  };
  var wbits = function(d, p, v) {
    v <<= p & 7;
    var o = p / 8 | 0;
    d[o] |= v;
    d[o + 1] |= v >> 8;
  };
  var wbits16 = function(d, p, v) {
    v <<= p & 7;
    var o = p / 8 | 0;
    d[o] |= v;
    d[o + 1] |= v >> 8;
    d[o + 2] |= v >> 16;
  };
  var hTree = function(d, mb) {
    var t = [];
    for (var i = 0; i < d.length; ++i) {
      if (d[i])
        t.push({ s: i, f: d[i] });
    }
    var s = t.length;
    var t2 = t.slice();
    if (!s)
      return { t: et, l: 0 };
    if (s == 1) {
      var v = new u8(t[0].s + 1);
      v[t[0].s] = 1;
      return { t: v, l: 1 };
    }
    t.sort(function(a, b) {
      return a.f - b.f;
    });
    t.push({ s: -1, f: 25001 });
    var l = t[0], r = t[1], i0 = 0, i1 = 1, i2 = 2;
    t[0] = { s: -1, f: l.f + r.f, l, r };
    while (i1 != s - 1) {
      l = t[t[i0].f < t[i2].f ? i0++ : i2++];
      r = t[i0 != i1 && t[i0].f < t[i2].f ? i0++ : i2++];
      t[i1++] = { s: -1, f: l.f + r.f, l, r };
    }
    var maxSym = t2[0].s;
    for (var i = 1; i < s; ++i) {
      if (t2[i].s > maxSym)
        maxSym = t2[i].s;
    }
    var tr = new u16(maxSym + 1);
    var mbt = ln(t[i1 - 1], tr, 0);
    if (mbt > mb) {
      var i = 0, dt = 0;
      var lft = mbt - mb, cst = 1 << lft;
      t2.sort(function(a, b) {
        return tr[b.s] - tr[a.s] || a.f - b.f;
      });
      for (; i < s; ++i) {
        var i2_1 = t2[i].s;
        if (tr[i2_1] > mb) {
          dt += cst - (1 << mbt - tr[i2_1]);
          tr[i2_1] = mb;
        } else
          break;
      }
      dt >>= lft;
      while (dt > 0) {
        var i2_2 = t2[i].s;
        if (tr[i2_2] < mb)
          dt -= 1 << mb - tr[i2_2]++ - 1;
        else
          ++i;
      }
      for (; i >= 0 && dt; --i) {
        var i2_3 = t2[i].s;
        if (tr[i2_3] == mb) {
          --tr[i2_3];
          ++dt;
        }
      }
      mbt = mb;
    }
    return { t: new u8(tr), l: mbt };
  };
  var ln = function(n, l, d) {
    return n.s == -1 ? Math.max(ln(n.l, l, d + 1), ln(n.r, l, d + 1)) : l[n.s] = d;
  };
  var lc = function(c) {
    var s = c.length;
    while (s && !c[--s])
      ;
    var cl = new u16(++s);
    var cli = 0, cln = c[0], cls = 1;
    var w = function(v) {
      cl[cli++] = v;
    };
    for (var i = 1; i <= s; ++i) {
      if (c[i] == cln && i != s)
        ++cls;
      else {
        if (!cln && cls > 2) {
          for (; cls > 138; cls -= 138)
            w(32754);
          if (cls > 2) {
            w(cls > 10 ? cls - 11 << 5 | 28690 : cls - 3 << 5 | 12305);
            cls = 0;
          }
        } else if (cls > 3) {
          w(cln), --cls;
          for (; cls > 6; cls -= 6)
            w(8304);
          if (cls > 2)
            w(cls - 3 << 5 | 8208), cls = 0;
        }
        while (cls--)
          w(cln);
        cls = 1;
        cln = c[i];
      }
    }
    return { c: cl.subarray(0, cli), n: s };
  };
  var clen = function(cf, cl) {
    var l = 0;
    for (var i = 0; i < cl.length; ++i)
      l += cf[i] * cl[i];
    return l;
  };
  var wfblk = function(out, pos, dat) {
    var s = dat.length;
    var o = shft(pos + 2);
    out[o] = s & 255;
    out[o + 1] = s >> 8;
    out[o + 2] = out[o] ^ 255;
    out[o + 3] = out[o + 1] ^ 255;
    for (var i = 0; i < s; ++i)
      out[o + i + 4] = dat[i];
    return (o + 4 + s) * 8;
  };
  var wblk = function(dat, out, final, syms, lf, df, eb, li, bs, bl, p) {
    wbits(out, p++, final);
    ++lf[256];
    var _a2 = hTree(lf, 15), dlt = _a2.t, mlb = _a2.l;
    var _b2 = hTree(df, 15), ddt = _b2.t, mdb = _b2.l;
    var _c = lc(dlt), lclt = _c.c, nlc = _c.n;
    var _d = lc(ddt), lcdt = _d.c, ndc = _d.n;
    var lcfreq = new u16(19);
    for (var i = 0; i < lclt.length; ++i)
      ++lcfreq[lclt[i] & 31];
    for (var i = 0; i < lcdt.length; ++i)
      ++lcfreq[lcdt[i] & 31];
    var _e = hTree(lcfreq, 7), lct = _e.t, mlcb = _e.l;
    var nlcc = 19;
    for (; nlcc > 4 && !lct[clim[nlcc - 1]]; --nlcc)
      ;
    var flen = bl + 5 << 3;
    var ftlen = clen(lf, flt) + clen(df, fdt) + eb;
    var dtlen = clen(lf, dlt) + clen(df, ddt) + eb + 14 + 3 * nlcc + clen(lcfreq, lct) + 2 * lcfreq[16] + 3 * lcfreq[17] + 7 * lcfreq[18];
    if (bs >= 0 && flen <= ftlen && flen <= dtlen)
      return wfblk(out, p, dat.subarray(bs, bs + bl));
    var lm, ll, dm, dl;
    wbits(out, p, 1 + (dtlen < ftlen)), p += 2;
    if (dtlen < ftlen) {
      lm = hMap(dlt, mlb, 0), ll = dlt, dm = hMap(ddt, mdb, 0), dl = ddt;
      var llm = hMap(lct, mlcb, 0);
      wbits(out, p, nlc - 257);
      wbits(out, p + 5, ndc - 1);
      wbits(out, p + 10, nlcc - 4);
      p += 14;
      for (var i = 0; i < nlcc; ++i)
        wbits(out, p + 3 * i, lct[clim[i]]);
      p += 3 * nlcc;
      var lcts = [lclt, lcdt];
      for (var it = 0; it < 2; ++it) {
        var clct = lcts[it];
        for (var i = 0; i < clct.length; ++i) {
          var len = clct[i] & 31;
          wbits(out, p, llm[len]), p += lct[len];
          if (len > 15)
            wbits(out, p, clct[i] >> 5 & 127), p += clct[i] >> 12;
        }
      }
    } else {
      lm = flm, ll = flt, dm = fdm, dl = fdt;
    }
    for (var i = 0; i < li; ++i) {
      var sym = syms[i];
      if (sym > 255) {
        var len = sym >> 18 & 31;
        wbits16(out, p, lm[len + 257]), p += ll[len + 257];
        if (len > 7)
          wbits(out, p, sym >> 23 & 31), p += fleb[len];
        var dst = sym & 31;
        wbits16(out, p, dm[dst]), p += dl[dst];
        if (dst > 3)
          wbits16(out, p, sym >> 5 & 8191), p += fdeb[dst];
      } else {
        wbits16(out, p, lm[sym]), p += ll[sym];
      }
    }
    wbits16(out, p, lm[256]);
    return p + ll[256];
  };
  var deo = /* @__PURE__ */ new i32([65540, 131080, 131088, 131104, 262176, 1048704, 1048832, 2114560, 2117632]);
  var et = /* @__PURE__ */ new u8(0);
  var dflt = function(dat, lvl, plvl, pre, post, st) {
    var s = st.z || dat.length;
    var o = new u8(pre + s + 5 * (1 + Math.ceil(s / 7e3)) + post);
    var w = o.subarray(pre, o.length - post);
    var lst = st.l;
    var pos = (st.r || 0) & 7;
    if (lvl) {
      if (pos)
        w[0] = st.r >> 3;
      var opt = deo[lvl - 1];
      var n = opt >> 13, c = opt & 8191;
      var msk_1 = (1 << plvl) - 1;
      var prev = st.p || new u16(32768), head = st.h || new u16(msk_1 + 1);
      var bs1_1 = Math.ceil(plvl / 3), bs2_1 = 2 * bs1_1;
      var hsh = function(i2) {
        return (dat[i2] ^ dat[i2 + 1] << bs1_1 ^ dat[i2 + 2] << bs2_1) & msk_1;
      };
      var syms = new i32(25e3);
      var lf = new u16(288), df = new u16(32);
      var lc_1 = 0, eb = 0, i = st.i || 0, li = 0, wi = st.w || 0, bs = 0;
      for (; i + 2 < s; ++i) {
        var hv = hsh(i);
        var imod = i & 32767, pimod = head[hv];
        prev[imod] = pimod;
        head[hv] = imod;
        if (wi <= i) {
          var rem = s - i;
          if ((lc_1 > 7e3 || li > 24576) && (rem > 423 || !lst)) {
            pos = wblk(dat, w, 0, syms, lf, df, eb, li, bs, i - bs, pos);
            li = lc_1 = eb = 0, bs = i;
            for (var j = 0; j < 286; ++j)
              lf[j] = 0;
            for (var j = 0; j < 30; ++j)
              df[j] = 0;
          }
          var l = 2, d = 0, ch_1 = c, dif = imod - pimod & 32767;
          if (rem > 2 && hv == hsh(i - dif)) {
            var maxn = Math.min(n, rem) - 1;
            var maxd = Math.min(32767, i);
            var ml = Math.min(258, rem);
            while (dif <= maxd && --ch_1 && imod != pimod) {
              if (dat[i + l] == dat[i + l - dif]) {
                var nl = 0;
                for (; nl < ml && dat[i + nl] == dat[i + nl - dif]; ++nl)
                  ;
                if (nl > l) {
                  l = nl, d = dif;
                  if (nl > maxn)
                    break;
                  var mmd = Math.min(dif, nl - 2);
                  var md = 0;
                  for (var j = 0; j < mmd; ++j) {
                    var ti = i - dif + j & 32767;
                    var pti = prev[ti];
                    var cd = ti - pti & 32767;
                    if (cd > md)
                      md = cd, pimod = ti;
                  }
                }
              }
              imod = pimod, pimod = prev[imod];
              dif += imod - pimod & 32767;
            }
          }
          if (d) {
            syms[li++] = 268435456 | revfl[l] << 18 | revfd[d];
            var lin = revfl[l] & 31, din = revfd[d] & 31;
            eb += fleb[lin] + fdeb[din];
            ++lf[257 + lin];
            ++df[din];
            wi = i + l;
            ++lc_1;
          } else {
            syms[li++] = dat[i];
            ++lf[dat[i]];
          }
        }
      }
      for (i = Math.max(i, wi); i < s; ++i) {
        syms[li++] = dat[i];
        ++lf[dat[i]];
      }
      pos = wblk(dat, w, lst, syms, lf, df, eb, li, bs, i - bs, pos);
      if (!lst) {
        st.r = pos & 7 | w[pos / 8 | 0] << 3;
        pos -= 7;
        st.h = head, st.p = prev, st.i = i, st.w = wi;
      }
    } else {
      for (var i = st.w || 0; i < s + lst; i += 65535) {
        var e = i + 65535;
        if (e >= s) {
          w[pos / 8 | 0] = lst;
          e = s;
        }
        pos = wfblk(w, pos + 1, dat.subarray(i, e));
      }
      st.i = s;
    }
    return slc(o, 0, pre + shft(pos) + post);
  };
  var adler = function() {
    var a = 1, b = 0;
    return {
      p: function(d) {
        var n = a, m = b;
        var l = d.length | 0;
        for (var i = 0; i != l; ) {
          var e = Math.min(i + 2655, l);
          for (; i < e; ++i)
            m += n += d[i];
          n = (n & 65535) + 15 * (n >> 16), m = (m & 65535) + 15 * (m >> 16);
        }
        a = n, b = m;
      },
      d: function() {
        a %= 65521, b %= 65521;
        return (a & 255) << 24 | (a & 65280) << 8 | (b & 255) << 8 | b >> 8;
      }
    };
  };
  var dopt = function(dat, opt, pre, post, st) {
    if (!st) {
      st = { l: 1 };
      if (opt.dictionary) {
        var dict = opt.dictionary.subarray(-32768);
        var newDat = new u8(dict.length + dat.length);
        newDat.set(dict);
        newDat.set(dat, dict.length);
        dat = newDat;
        st.w = dict.length;
      }
    }
    return dflt(dat, opt.level == null ? 6 : opt.level, opt.mem == null ? st.l ? Math.ceil(Math.max(8, Math.min(13, Math.log(dat.length))) * 1.5) : 20 : 12 + opt.mem, pre, post, st);
  };
  var wbytes = function(d, b, v) {
    for (; v; ++b)
      d[b] = v, v >>>= 8;
  };
  var zlh = function(c, o) {
    var lv = o.level, fl2 = lv == 0 ? 0 : lv < 6 ? 1 : lv == 9 ? 3 : 2;
    c[0] = 120, c[1] = fl2 << 6 | (o.dictionary && 32);
    c[1] |= 31 - (c[0] << 8 | c[1]) % 31;
    if (o.dictionary) {
      var h = adler();
      h.p(o.dictionary);
      wbytes(c, 2, h.d());
    }
  };
  var zls = function(d, dict) {
    if ((d[0] & 15) != 8 || d[0] >> 4 > 7 || (d[0] << 8 | d[1]) % 31)
      err(6, "invalid zlib data");
    if ((d[1] >> 5 & 1) == +!dict)
      err(6, "invalid zlib data: " + (d[1] & 32 ? "need" : "unexpected") + " dictionary");
    return (d[1] >> 3 & 4) + 2;
  };
  function inflateSync(data, opts) {
    return inflt(data, { i: 2 }, opts && opts.out, opts && opts.dictionary);
  }
  function zlibSync(data, opts) {
    if (!opts)
      opts = {};
    var a = adler();
    a.p(data);
    var d = dopt(data, opts, opts.dictionary ? 6 : 2, 4);
    return zlh(d, opts), wbytes(d, d.length - 4, a.d()), d;
  }
  function unzlibSync(data, opts) {
    return inflt(data.subarray(zls(data, opts && opts.dictionary), -4), { i: 2 }, opts && opts.out, opts && opts.dictionary);
  }
  var td = typeof TextDecoder != "undefined" && /* @__PURE__ */ new TextDecoder();
  var tds = 0;
  try {
    td.decode(et, { stream: true });
    tds = 1;
  } catch (e) {
  }

  // binary.ts
  function nextZero(data, p) {
    while (data[p] !== 0) p++;
    return p;
  }
  function readUshort(buff, p) {
    return buff[p] << 8 | buff[p + 1];
  }
  function writeUshort(buff, p, n) {
    buff[p] = n >> 8 & 255;
    buff[p + 1] = n & 255;
  }
  function readUint(buff, p) {
    return buff[p] * (256 * 256 * 256) + (buff[p + 1] << 16 | buff[p + 2] << 8 | buff[p + 3]);
  }
  function writeUint(buff, p, n) {
    buff[p] = n >> 24 & 255;
    buff[p + 1] = n >> 16 & 255;
    buff[p + 2] = n >> 8 & 255;
    buff[p + 3] = n & 255;
  }
  function readASCII(buff, p, l) {
    let s = "";
    for (let i = 0; i < l; i++) s += String.fromCharCode(buff[p + i]);
    return s;
  }
  function writeASCII(data, p, s) {
    for (let i = 0; i < s.length; i++) data[p + i] = s.charCodeAt(i);
  }
  function readBytes(buff, p, l) {
    const arr = [];
    for (let i = 0; i < l; i++) arr.push(buff[p + i]);
    return arr;
  }
  function padHex(n) {
    return n.length < 2 ? "0" + n : n;
  }
  function readUTF8(buff, p, l) {
    let s = "";
    for (let i = 0; i < l; i++) {
      s += "%" + padHex(buff[p + i].toString(16));
    }
    try {
      return decodeURIComponent(s);
    } catch (e) {
      return readASCII(buff, p, l);
    }
  }
  var CRC_TABLE = (() => {
    const tab = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
      }
      tab[n] = c;
    }
    return tab;
  })();
  function crcUpdate(c, buf, off, len) {
    for (let i = 0; i < len; i++) {
      c = CRC_TABLE[(c ^ buf[off + i]) & 255] ^ c >>> 8;
    }
    return c;
  }
  function crc(buf, off, len) {
    return crcUpdate(4294967295, buf, off, len) ^ 4294967295;
  }

  // filter.ts
  function paeth(a, b, c) {
    const p = a + b - c;
    const pa = p - a;
    const pb = p - b;
    const pc = p - c;
    if (pa * pa <= pb * pb && pa * pa <= pc * pc) return a;
    if (pb * pb <= pc * pc) return b;
    return c;
  }
  function getBPP(out) {
    const channels = [1, 0, 3, 1, 2, 0, 4][out.ctype];
    return channels * out.depth;
  }
  function filterZero(data, out, off, w, h) {
    let bpp = getBPP(out);
    const bpl = Math.ceil(w * bpp / 8);
    bpp = Math.ceil(bpp / 8);
    let type = data[off];
    let x = 0;
    if (type > 1) data[off] = [0, 0, 1][type - 2];
    if (type === 3) {
      for (x = bpp; x < bpl; x++) {
        data[x + 1] = data[x + 1] + (data[x + 1 - bpp] >>> 1) & 255;
      }
    }
    for (let y = 0; y < h; y++) {
      const i = off + y * bpl;
      const di = i + y + 1;
      type = data[di - 1];
      x = 0;
      if (type === 0) {
        for (; x < bpl; x++) data[i + x] = data[di + x];
      } else if (type === 1) {
        for (; x < bpp; x++) data[i + x] = data[di + x];
        for (; x < bpl; x++) data[i + x] = data[di + x] + data[i + x - bpp];
      } else if (type === 2) {
        for (; x < bpl; x++) data[i + x] = data[di + x] + data[i + x - bpl];
      } else if (type === 3) {
        for (; x < bpp; x++) {
          data[i + x] = data[di + x] + (data[i + x - bpl] >>> 1);
        }
        for (; x < bpl; x++) {
          data[i + x] = data[di + x] + (data[i + x - bpl] + data[i + x - bpp] >>> 1);
        }
      } else {
        for (; x < bpp; x++) {
          data[i + x] = data[di + x] + paeth(0, data[i + x - bpl], 0);
        }
        for (; x < bpl; x++) {
          data[i + x] = data[di + x] + paeth(data[i + x - bpp], data[i + x - bpl], data[i + x - bpp - bpl]);
        }
      }
    }
    return data;
  }
  function readInterlace(data, out) {
    const w = out.width;
    const h = out.height;
    const bpp = getBPP(out);
    const cbpp = bpp >> 3;
    const bpl = Math.ceil(w * bpp / 8);
    const img = new Uint8Array(h * bpl);
    let di = 0;
    const starting_row = [0, 0, 4, 0, 2, 0, 1];
    const starting_col = [0, 4, 0, 2, 0, 1, 0];
    const row_increment = [8, 8, 8, 4, 4, 2, 2];
    const col_increment = [8, 8, 4, 4, 2, 2, 1];
    for (let pass = 0; pass < 7; pass++) {
      const ri = row_increment[pass];
      const ci = col_increment[pass];
      let sw = 0;
      let sh = 0;
      let cr = starting_row[pass];
      while (cr < h) {
        cr += ri;
        sh++;
      }
      let cc = starting_col[pass];
      while (cc < w) {
        cc += ci;
        sw++;
      }
      const bpll = Math.ceil(sw * bpp / 8);
      filterZero(data, out, di, sw, sh);
      let y = 0;
      let row = starting_row[pass];
      while (row < h) {
        let col = starting_col[pass];
        let cdi = di + y * bpll << 3;
        while (col < w) {
          if (bpp === 1) {
            let val = data[cdi >> 3];
            val = val >> 7 - (cdi & 7) & 1;
            img[row * bpl + (col >> 3)] |= val << 7 - (col & 7);
          }
          if (bpp === 2) {
            let val = data[cdi >> 3];
            val = val >> 6 - (cdi & 7) & 3;
            img[row * bpl + (col >> 2)] |= val << 6 - ((col & 3) << 1);
          }
          if (bpp === 4) {
            let val = data[cdi >> 3];
            val = val >> 4 - (cdi & 7) & 15;
            img[row * bpl + (col >> 1)] |= val << 4 - ((col & 1) << 2);
          }
          if (bpp >= 8) {
            const ii = row * bpl + col * cbpp;
            for (let j = 0; j < cbpp; j++) img[ii + j] = data[(cdi >> 3) + j];
          }
          cdi += bpp;
          col += ci;
        }
        y++;
        row += ri;
      }
      if (sw * sh !== 0) di += sh * (1 + bpll);
    }
    return img;
  }
  function filterLine(data, img, y, bpl, bpp, type) {
    const i = y * bpl;
    let di = i + y;
    data[di] = type;
    di++;
    if (type === 0) {
      if (bpl < 500) {
        for (let x = 0; x < bpl; x++) data[di + x] = img[i + x];
      } else {
        data.set(img.subarray(i, i + bpl), di);
      }
    } else if (type === 1) {
      for (let x = 0; x < bpp; x++) data[di + x] = img[i + x];
      for (let x = bpp; x < bpl; x++) {
        data[di + x] = img[i + x] - img[i + x - bpp] + 256 & 255;
      }
    } else if (y === 0) {
      for (let x = 0; x < bpp; x++) data[di + x] = img[i + x];
      if (type === 2) {
        for (let x = bpp; x < bpl; x++) data[di + x] = img[i + x];
      }
      if (type === 3) {
        for (let x = bpp; x < bpl; x++) {
          data[di + x] = img[i + x] - (img[i + x - bpp] >> 1) + 256 & 255;
        }
      }
      if (type === 4) {
        for (let x = bpp; x < bpl; x++) {
          data[di + x] = img[i + x] - paeth(img[i + x - bpp], 0, 0) + 256 & 255;
        }
      }
    } else {
      if (type === 2) {
        for (let x = 0; x < bpl; x++) {
          data[di + x] = img[i + x] + 256 - img[i + x - bpl] & 255;
        }
      }
      if (type === 3) {
        for (let x = 0; x < bpp; x++) {
          data[di + x] = img[i + x] + 256 - (img[i + x - bpl] >> 1) & 255;
        }
        for (let x = bpp; x < bpl; x++) {
          data[di + x] = img[i + x] + 256 - (img[i + x - bpl] + img[i + x - bpp] >> 1) & 255;
        }
      }
      if (type === 4) {
        for (let x = 0; x < bpp; x++) {
          data[di + x] = img[i + x] + 256 - paeth(0, img[i + x - bpl], 0) & 255;
        }
        for (let x = bpp; x < bpl; x++) {
          data[di + x] = img[i + x] + 256 - paeth(img[i + x - bpp], img[i + x - bpl], img[i + x - bpp - bpl]) & 255;
        }
      }
    }
  }

  // decode.ts
  var PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];
  function readIHDR(data, offset, out) {
    out.width = readUint(data, offset);
    offset += 4;
    out.height = readUint(data, offset);
    offset += 4;
    out.depth = data[offset++];
    out.ctype = data[offset++];
    out.compress = data[offset++];
    out.filter = data[offset++];
    out.interlace = data[offset++];
  }
  function inflateZlib(data) {
    return unzlibSync(data);
  }
  function decompress(out, dd, w, h) {
    const inflated = out.tabs.CgBI ? inflateSync(dd) : inflateZlib(dd);
    if (out.interlace === 0) return filterZero(inflated, out, 0, w, h);
    if (out.interlace === 1) return readInterlace(inflated, out);
    return inflated;
  }
  function decode(buff) {
    const data = new Uint8Array(buff);
    let offset = 8;
    for (let i = 0; i < 8; i++) {
      if (data[i] !== PNG_SIG[i]) {
        throw new Error("The input is not a PNG file!");
      }
    }
    const out = {
      tabs: {},
      frames: []
    };
    const dd = new Uint8Array(data.length);
    let doff = 0;
    let fd2;
    let foff = 0;
    while (offset < data.length) {
      const len = readUint(data, offset);
      offset += 4;
      const type = readASCII(data, offset, 4);
      offset += 4;
      if (type === "IHDR") {
        readIHDR(data, offset, out);
      } else if (type === "CgBI") {
        out.tabs.CgBI = data.slice(offset, offset + 4);
      } else if (type === "IDAT") {
        for (let i = 0; i < len; i++) dd[doff + i] = data[offset + i];
        doff += len;
      } else if (type === "acTL") {
        out.tabs.acTL = {
          num_frames: readUint(data, offset),
          num_plays: readUint(data, offset + 4)
        };
        fd2 = new Uint8Array(data.length);
      } else if (type === "fcTL") {
        if (foff !== 0 && fd2) {
          const fr = out.frames[out.frames.length - 1];
          fr.data = decompress(
            out,
            fd2.slice(0, foff),
            fr.rect.width,
            fr.rect.height
          );
          foff = 0;
        }
        const rct = {
          x: readUint(data, offset + 12),
          y: readUint(data, offset + 16),
          width: readUint(data, offset + 4),
          height: readUint(data, offset + 8)
        };
        let del = readUshort(data, offset + 22);
        del = readUshort(data, offset + 20) / (del === 0 ? 100 : del);
        out.frames.push({
          rect: rct,
          delay: Math.round(del * 1e3),
          dispose: data[offset + 24],
          blend: data[offset + 25]
        });
      } else if (type === "fdAT") {
        if (!fd2) fd2 = new Uint8Array(data.length);
        for (let i = 0; i < len - 4; i++) fd2[foff + i] = data[offset + i + 4];
        foff += len - 4;
      } else if (type === "pHYs") {
        out.tabs.pHYs = [
          readUint(data, offset),
          readUint(data, offset + 4),
          data[offset + 8]
        ];
      } else if (type === "cHRM") {
        out.tabs.cHRM = [];
        for (let i = 0; i < 8; i++) {
          out.tabs.cHRM.push(readUint(data, offset + i * 4));
        }
      } else if (type === "tEXt" || type === "zTXt") {
        const textTab = type === "tEXt" ? "tEXt" : "zTXt";
        if (out.tabs[textTab] === void 0) out.tabs[textTab] = {};
        const nz = nextZero(data, offset);
        const keyw = readASCII(data, offset, nz - offset);
        const tl = offset + len - nz - 1;
        let text;
        if (type === "tEXt") {
          text = readASCII(data, nz + 1, tl);
        } else {
          const bfr = inflateZlib(data.subarray(nz + 2, offset + len));
          text = readUTF8(bfr, 0, bfr.length);
        }
        out.tabs[textTab][keyw] = text;
      } else if (type === "iTXt") {
        if (out.tabs.iTXt === void 0) out.tabs.iTXt = {};
        let off = offset;
        let nz = nextZero(data, off);
        const keyw = readASCII(data, off, nz - off);
        off = nz + 1;
        const cflag = data[off];
        off += 2;
        nz = nextZero(data, off);
        off = nz + 1;
        nz = nextZero(data, off);
        off = nz + 1;
        const tl = len - (off - offset);
        let text;
        if (cflag === 0) text = readUTF8(data, off, tl);
        else {
          const bfr = inflateZlib(data.subarray(off, off + tl));
          text = readUTF8(bfr, 0, bfr.length);
        }
        out.tabs.iTXt[keyw] = text;
      } else if (type === "PLTE") {
        out.tabs.PLTE = readBytes(data, offset, len);
      } else if (type === "hIST") {
        const pl = out.tabs.PLTE.length / 3;
        out.tabs.hIST = [];
        for (let i = 0; i < pl; i++) {
          out.tabs.hIST.push(readUshort(data, offset + i * 2));
        }
      } else if (type === "tRNS") {
        if (out.ctype === 3) out.tabs.tRNS = readBytes(data, offset, len);
        else if (out.ctype === 0) out.tabs.tRNS = readUshort(data, offset);
        else if (out.ctype === 2) {
          out.tabs.tRNS = [
            readUshort(data, offset),
            readUshort(data, offset + 2),
            readUshort(data, offset + 4)
          ];
        }
      } else if (type === "gAMA") {
        out.tabs.gAMA = readUint(data, offset) / 1e5;
      } else if (type === "sRGB") {
        out.tabs.sRGB = data[offset];
      } else if (type === "bKGD") {
        if (out.ctype === 0 || out.ctype === 4) {
          out.tabs.bKGD = [readUshort(data, offset)];
        } else if (out.ctype === 2 || out.ctype === 6) {
          out.tabs.bKGD = [
            readUshort(data, offset),
            readUshort(data, offset + 2),
            readUshort(data, offset + 4)
          ];
        } else if (out.ctype === 3) {
          out.tabs.bKGD = data[offset];
        }
      } else if (type === "IEND") {
        break;
      }
      offset += len;
      offset += 4;
    }
    if (foff !== 0 && fd2) {
      const fr = out.frames[out.frames.length - 1];
      fr.data = decompress(out, fd2.slice(0, foff), fr.rect.width, fr.rect.height);
    }
    out.data = decompress(out, dd.subarray(0, doff), out.width, out.height);
    const _a2 = out, { compress: _c, filter: _f, interlace: _i } = _a2, image = __objRest(_a2, ["compress", "filter", "interlace"]);
    return image;
  }

  // dither.ts
  function clamp255(x) {
    return Math.max(0, Math.min(255, x));
  }
  function sqDist(a, b) {
    const dr = a[0] - b[0];
    const dg = a[1] - b[1];
    const db = a[2] - b[2];
    const da = a[3] - b[3];
    return dr * dr + dg * dg + db * db + da * da;
  }
  function addErr(er, tg, ti, f) {
    tg[ti] += er[0] * f >> 4;
    tg[ti + 1] += er[1] * f >> 4;
    tg[ti + 2] += er[2] * f >> 4;
    tg[ti + 3] += er[3] * f >> 4;
  }
  var BAYER_S = 4;
  var BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(
    (v) => 255 * (-0.5 + (v + 0.5) / (BAYER_S * BAYER_S))
  );
  function dither(sb, w, h, plte, tb, oind, MTD = 1) {
    const pc = plte.length;
    const nplt = [];
    for (let i = 0; i < pc; i++) {
      const c = plte[i];
      nplt.push([c & 255, c >>> 8 & 255, c >>> 16 & 255, c >>> 24 & 255]);
    }
    const tb32 = new Uint32Array(tb.buffer, tb.byteOffset, tb.length >> 2);
    const err2 = new Int16Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        let cc;
        if (MTD !== 2) {
          cc = [
            clamp255(sb[i] + err2[i]),
            clamp255(sb[i + 1] + err2[i + 1]),
            clamp255(sb[i + 2] + err2[i + 2]),
            clamp255(sb[i + 3] + err2[i + 3])
          ];
        } else {
          const ce = BAYER[(y & BAYER_S - 1) * BAYER_S + (x & BAYER_S - 1)];
          cc = [
            clamp255(sb[i] + ce),
            clamp255(sb[i + 1] + ce),
            clamp255(sb[i + 2] + ce),
            clamp255(sb[i + 3] + ce)
          ];
        }
        let ni = 0;
        let nd = 16777215;
        for (let j = 0; j < pc; j++) {
          const cd = sqDist(cc, nplt[j]);
          if (cd < nd) {
            nd = cd;
            ni = j;
          }
        }
        const nc = nplt[ni];
        if (MTD === 1) {
          const er = [cc[0] - nc[0], cc[1] - nc[1], cc[2] - nc[2], cc[3] - nc[3]];
          if (x !== w - 1) addErr(er, err2, i + 4, 7);
          if (y !== h - 1) {
            if (x !== 0) addErr(er, err2, i + 4 * w - 4, 3);
            addErr(er, err2, i + 4 * w, 5);
            if (x !== w - 1) addErr(er, err2, i + 4 * w + 4, 1);
          }
        }
        oind[i >> 2] = ni;
        tb32[i >> 2] = plte[ni];
      }
    }
  }

  // rgba.ts
  function copyTile(sb, sw, sh, tb, tw, th, xoff, yoff, mode) {
    const w = Math.min(sw, tw);
    const h = Math.min(sh, th);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let si;
        let ti;
        if (xoff >= 0 && yoff >= 0) {
          si = y * sw + x << 2;
          ti = (yoff + y) * tw + xoff + x << 2;
        } else {
          si = (-yoff + y) * sw - xoff + x << 2;
          ti = y * tw + x << 2;
        }
        if (mode === 0) {
          tb[ti] = sb[si];
          tb[ti + 1] = sb[si + 1];
          tb[ti + 2] = sb[si + 2];
          tb[ti + 3] = sb[si + 3];
        } else if (mode === 1) {
          const fa = sb[si + 3] * (1 / 255);
          const fr = sb[si] * fa;
          const fg = sb[si + 1] * fa;
          const fb = sb[si + 2] * fa;
          const ba = tb[ti + 3] * (1 / 255);
          const br = tb[ti] * ba;
          const bg = tb[ti + 1] * ba;
          const bb = tb[ti + 2] * ba;
          const ifa = 1 - fa;
          const oa = fa + ba * ifa;
          const ioa = oa === 0 ? 0 : 1 / oa;
          tb[ti + 3] = 255 * oa;
          tb[ti] = (fr + br * ifa) * ioa;
          tb[ti + 1] = (fg + bg * ifa) * ioa;
          tb[ti + 2] = (fb + bb * ifa) * ioa;
        } else if (mode === 2) {
          const fa = sb[si + 3];
          const fr = sb[si];
          const fg = sb[si + 1];
          const fb = sb[si + 2];
          const ba = tb[ti + 3];
          const br = tb[ti];
          const bg = tb[ti + 1];
          const bb = tb[ti + 2];
          if (fa === ba && fr === br && fg === bg && fb === bb) {
            tb[ti] = 0;
            tb[ti + 1] = 0;
            tb[ti + 2] = 0;
            tb[ti + 3] = 0;
          } else {
            tb[ti] = fr;
            tb[ti + 1] = fg;
            tb[ti + 2] = fb;
            tb[ti + 3] = fa;
          }
        } else if (mode === 3) {
          const fa = sb[si + 3];
          const fr = sb[si];
          const fg = sb[si + 1];
          const fb = sb[si + 2];
          const ba = tb[ti + 3];
          const br = tb[ti];
          const bg = tb[ti + 1];
          const bb = tb[ti + 2];
          if (fa === ba && fr === br && fg === bg && fb === bb) continue;
          if (fa < 220 && ba > 20) return false;
        }
      }
    }
    return true;
  }
  function decodeImage(data, w, h, out) {
    const area = w * h;
    const bpp = getBPP(out);
    const bpl = Math.ceil(w * bpp / 8);
    const bf = new Uint8Array(area * 4);
    const bf32 = new Uint32Array(bf.buffer);
    const ctype = out.ctype;
    const depth = out.depth;
    if (ctype === 6) {
      const qarea = area << 2;
      if (depth === 8) {
        for (let i = 0; i < qarea; i += 4) {
          bf[i] = data[i];
          bf[i + 1] = data[i + 1];
          bf[i + 2] = data[i + 2];
          bf[i + 3] = data[i + 3];
        }
      }
      if (depth === 16) {
        for (let i = 0; i < qarea; i++) bf[i] = data[i << 1];
      }
    } else if (ctype === 2) {
      const ts = out.tabs.tRNS;
      if (ts === void 0) {
        if (depth === 8) {
          for (let i = 0; i < area; i++) {
            const ti = i * 3;
            bf32[i] = 255 << 24 | data[ti + 2] << 16 | data[ti + 1] << 8 | data[ti];
          }
        }
        if (depth === 16) {
          for (let i = 0; i < area; i++) {
            const ti = i * 6;
            bf32[i] = 255 << 24 | data[ti + 4] << 16 | data[ti + 2] << 8 | data[ti];
          }
        }
      } else {
        const tr = ts[0];
        const tg = ts[1];
        const tb = ts[2];
        if (depth === 8) {
          for (let i = 0; i < area; i++) {
            const qi = i << 2;
            const ti = i * 3;
            bf32[i] = 255 << 24 | data[ti + 2] << 16 | data[ti + 1] << 8 | data[ti];
            if (data[ti] === tr && data[ti + 1] === tg && data[ti + 2] === tb) {
              bf[qi + 3] = 0;
            }
          }
        }
        if (depth === 16) {
          for (let i = 0; i < area; i++) {
            const qi = i << 2;
            const ti = i * 6;
            bf32[i] = 255 << 24 | data[ti + 4] << 16 | data[ti + 2] << 8 | data[ti];
            if (readUshort(data, ti) === tr && readUshort(data, ti + 2) === tg && readUshort(data, ti + 4) === tb) {
              bf[qi + 3] = 0;
            }
          }
        }
      }
    } else if (ctype === 3) {
      const p = out.tabs.PLTE;
      const ap = out.tabs.tRNS;
      const tl = ap ? ap.length : 0;
      if (depth === 1) {
        for (let y = 0; y < h; y++) {
          const s0 = y * bpl;
          const t0 = y * w;
          for (let i = 0; i < w; i++) {
            const qi = t0 + i << 2;
            const j = data[s0 + (i >> 3)] >> 7 - (i & 7) & 1;
            const cj = 3 * j;
            bf[qi] = p[cj];
            bf[qi + 1] = p[cj + 1];
            bf[qi + 2] = p[cj + 2];
            bf[qi + 3] = j < tl ? ap[j] : 255;
          }
        }
      }
      if (depth === 2) {
        for (let y = 0; y < h; y++) {
          const s0 = y * bpl;
          const t0 = y * w;
          for (let i = 0; i < w; i++) {
            const qi = t0 + i << 2;
            const j = data[s0 + (i >> 2)] >> 6 - ((i & 3) << 1) & 3;
            const cj = 3 * j;
            bf[qi] = p[cj];
            bf[qi + 1] = p[cj + 1];
            bf[qi + 2] = p[cj + 2];
            bf[qi + 3] = j < tl ? ap[j] : 255;
          }
        }
      }
      if (depth === 4) {
        for (let y = 0; y < h; y++) {
          const s0 = y * bpl;
          const t0 = y * w;
          for (let i = 0; i < w; i++) {
            const qi = t0 + i << 2;
            const j = data[s0 + (i >> 1)] >> 4 - ((i & 1) << 2) & 15;
            const cj = 3 * j;
            bf[qi] = p[cj];
            bf[qi + 1] = p[cj + 1];
            bf[qi + 2] = p[cj + 2];
            bf[qi + 3] = j < tl ? ap[j] : 255;
          }
        }
      }
      if (depth === 8) {
        for (let i = 0; i < area; i++) {
          const qi = i << 2;
          const j = data[i];
          const cj = 3 * j;
          bf[qi] = p[cj];
          bf[qi + 1] = p[cj + 1];
          bf[qi + 2] = p[cj + 2];
          bf[qi + 3] = j < tl ? ap[j] : 255;
        }
      }
    } else if (ctype === 4) {
      if (depth === 8) {
        for (let i = 0; i < area; i++) {
          const qi = i << 2;
          const di = i << 1;
          const gr = data[di];
          bf[qi] = gr;
          bf[qi + 1] = gr;
          bf[qi + 2] = gr;
          bf[qi + 3] = data[di + 1];
        }
      }
      if (depth === 16) {
        for (let i = 0; i < area; i++) {
          const qi = i << 2;
          const di = i << 2;
          const gr = data[di];
          bf[qi] = gr;
          bf[qi + 1] = gr;
          bf[qi + 2] = gr;
          bf[qi + 3] = data[di + 2];
        }
      }
    } else if (ctype === 0) {
      const tr = out.tabs.tRNS !== void 0 ? out.tabs.tRNS : -1;
      for (let y = 0; y < h; y++) {
        const off = y * bpl;
        const to = y * w;
        if (depth === 1) {
          for (let x = 0; x < w; x++) {
            const gr = 255 * (data[off + (x >>> 3)] >>> 7 - (x & 7) & 1);
            const al = gr === tr * 255 ? 0 : 255;
            bf32[to + x] = al << 24 | gr << 16 | gr << 8 | gr;
          }
        } else if (depth === 2) {
          for (let x = 0; x < w; x++) {
            const gr = 85 * (data[off + (x >>> 2)] >>> 6 - ((x & 3) << 1) & 3);
            const al = gr === tr * 85 ? 0 : 255;
            bf32[to + x] = al << 24 | gr << 16 | gr << 8 | gr;
          }
        } else if (depth === 4) {
          for (let x = 0; x < w; x++) {
            const gr = 17 * (data[off + (x >>> 1)] >>> 4 - ((x & 1) << 2) & 15);
            const al = gr === tr * 17 ? 0 : 255;
            bf32[to + x] = al << 24 | gr << 16 | gr << 8 | gr;
          }
        } else if (depth === 8) {
          for (let x = 0; x < w; x++) {
            const gr = data[off + x];
            const al = gr === tr ? 0 : 255;
            bf32[to + x] = al << 24 | gr << 16 | gr << 8 | gr;
          }
        } else if (depth === 16) {
          for (let x = 0; x < w; x++) {
            const gr = data[off + (x << 1)];
            const al = readUshort(data, off + (x << 1)) === tr ? 0 : 255;
            bf32[to + x] = al << 24 | gr << 16 | gr << 8 | gr;
          }
        }
      }
    }
    return bf;
  }
  function toRGBA8(out) {
    const w = out.width;
    const h = out.height;
    if (out.tabs.acTL === void 0) {
      return [decodeImage(out.data, w, h, out).buffer];
    }
    const frms = [];
    if (out.frames[0].data === void 0) out.frames[0].data = out.data;
    const len = w * h * 4;
    const img = new Uint8Array(len);
    const empty = new Uint8Array(len);
    const prev = new Uint8Array(len);
    for (let i = 0; i < out.frames.length; i++) {
      const frm = out.frames[i];
      const fx = frm.rect.x;
      const fy = frm.rect.y;
      const fw = frm.rect.width;
      const fh = frm.rect.height;
      const fdata = decodeImage(frm.data, fw, fh, out);
      if (i !== 0) for (let j = 0; j < len; j++) prev[j] = img[j];
      if (frm.blend === 0) copyTile(fdata, fw, fh, img, w, h, fx, fy, 0);
      else if (frm.blend === 1) copyTile(fdata, fw, fh, img, w, h, fx, fy, 1);
      frms.push(img.buffer.slice(0));
      if (frm.dispose === 1) {
        copyTile(empty, fw, fh, img, w, h, fx, fy, 0);
      } else if (frm.dispose === 2) {
        for (let j = 0; j < len; j++) img[j] = prev[j];
      }
    }
    return frms;
  }

  // framize.ts
  function prepareDiff(cimg, w, h, nimg, rec) {
    copyTile(cimg, w, h, nimg, rec.width, rec.height, -rec.x, -rec.y, 2);
  }
  function updateFrame(bufs, w, h, frms, i, r, evenCrd) {
    const pimg = new Uint8Array(bufs[i - 1]);
    const pimg32 = new Uint32Array(bufs[i - 1]);
    const nimg = i + 1 < bufs.length ? new Uint8Array(bufs[i + 1]) : null;
    const cimg = new Uint8Array(bufs[i]);
    const cimg32 = new Uint32Array(cimg.buffer);
    let mix = w;
    let miy = h;
    let max2 = -1;
    let may = -1;
    for (let y = 0; y < r.height; y++) {
      for (let x = 0; x < r.width; x++) {
        const cx = r.x + x;
        const cy = r.y + y;
        const j = cy * w + cx;
        const cc = cimg32[j];
        const skip = cc === 0 || frms[i - 1].dispose === 0 && pimg32[j] === cc && (nimg === null || nimg[j * 4 + 3] !== 0);
        if (skip) continue;
        if (cx < mix) mix = cx;
        if (cx > max2) max2 = cx;
        if (cy < miy) miy = cy;
        if (cy > may) may = cy;
      }
    }
    if (max2 === -1) mix = miy = max2 = may = 0;
    if (evenCrd) {
      if ((mix & 1) === 1) mix--;
      if ((miy & 1) === 1) miy--;
    }
    const nr = { x: mix, y: miy, width: max2 - mix + 1, height: may - miy + 1 };
    const fr = frms[i];
    fr.rect = nr;
    fr.blend = 1;
    fr.img = new Uint8Array(nr.width * nr.height * 4);
    if (frms[i - 1].dispose === 0) {
      copyTile(pimg, w, h, fr.img, nr.width, nr.height, -nr.x, -nr.y, 0);
      prepareDiff(cimg, w, h, fr.img, nr);
    } else {
      copyTile(cimg, w, h, fr.img, nr.width, nr.height, -nr.x, -nr.y, 0);
    }
  }
  function framize(bufs, w, h, alwaysBlend, evenCrd, forbidPrev) {
    const frms = [];
    for (let j = 0; j < bufs.length; j++) {
      const cimg = new Uint8Array(bufs[j]);
      const cimg32 = new Uint32Array(cimg.buffer);
      let nimg;
      let nx = 0;
      let ny = 0;
      let nw = w;
      let nh = h;
      let blend = alwaysBlend ? 1 : 0;
      if (j !== 0) {
        const tlim = forbidPrev || alwaysBlend || j === 1 || frms[j - 2].dispose !== 0 ? 1 : 2;
        let tstp = 0;
        let tarea = 1e9;
        for (let it = 0; it < tlim; it++) {
          const p32 = new Uint32Array(bufs[j - 1 - it]);
          let mix = w;
          let miy = h;
          let max2 = -1;
          let may = -1;
          for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
              const i = y * w + x;
              if (cimg32[i] !== p32[i]) {
                if (x < mix) mix = x;
                if (x > max2) max2 = x;
                if (y < miy) miy = y;
                if (y > may) may = y;
              }
            }
          }
          if (max2 === -1) mix = miy = max2 = may = 0;
          if (evenCrd) {
            if ((mix & 1) === 1) mix--;
            if ((miy & 1) === 1) miy--;
          }
          const sarea = (max2 - mix + 1) * (may - miy + 1);
          if (sarea < tarea) {
            tarea = sarea;
            tstp = it;
            nx = mix;
            ny = miy;
            nw = max2 - mix + 1;
            nh = may - miy + 1;
          }
        }
        const pimg = new Uint8Array(bufs[j - 1 - tstp]);
        if (tstp === 1) frms[j - 1].dispose = 2;
        nimg = new Uint8Array(nw * nh * 4);
        copyTile(pimg, w, h, nimg, nw, nh, -nx, -ny, 0);
        blend = copyTile(cimg, w, h, nimg, nw, nh, -nx, -ny, 3) ? 1 : 0;
        if (blend === 1) {
          prepareDiff(cimg, w, h, nimg, { x: nx, y: ny, width: nw, height: nh });
        } else {
          copyTile(cimg, w, h, nimg, nw, nh, -nx, -ny, 0);
        }
      } else {
        nimg = cimg.slice(0);
      }
      frms.push({
        rect: { x: nx, y: ny, width: nw, height: nh },
        img: nimg,
        blend,
        dispose: 0
      });
    }
    if (alwaysBlend) {
      for (let j = 0; j < frms.length; j++) {
        const frm = frms[j];
        if (frm.blend === 1) continue;
        const r0 = frm.rect;
        const r1 = frms[j - 1].rect;
        const miX = Math.min(r0.x, r1.x);
        const miY = Math.min(r0.y, r1.y);
        const maX = Math.max(r0.x + r0.width, r1.x + r1.width);
        const maY = Math.max(r0.y + r0.height, r1.y + r1.height);
        const r = { x: miX, y: miY, width: maX - miX, height: maY - miY };
        frms[j - 1].dispose = 1;
        if (j - 1 !== 0) updateFrame(bufs, w, h, frms, j - 1, r, evenCrd);
        updateFrame(bufs, w, h, frms, j, r, evenCrd);
      }
    }
    return frms;
  }
  function concatRGBA(bufs) {
    let tlen = 0;
    for (let i = 0; i < bufs.length; i++) tlen += bufs[i].byteLength;
    const nimg = new Uint8Array(tlen);
    let noff = 0;
    for (let i = 0; i < bufs.length; i++) {
      const img = new Uint8Array(bufs[i]);
      const il = img.length;
      for (let j = 0; j < il; j += 4) {
        let r = img[j];
        let g = img[j + 1];
        let b = img[j + 2];
        const a = img[j + 3];
        if (a === 0) r = g = b = 0;
        nimg[noff + j] = r;
        nimg[noff + j + 1] = g;
        nimg[noff + j + 2] = b;
        nimg[noff + j + 3] = a;
      }
      noff += il;
    }
    return nimg.buffer;
  }

  // quantize.ts
  var M4 = {
    multVec(m, v) {
      return [
        m[0] * v[0] + m[1] * v[1] + m[2] * v[2] + m[3] * v[3],
        m[4] * v[0] + m[5] * v[1] + m[6] * v[2] + m[7] * v[3],
        m[8] * v[0] + m[9] * v[1] + m[10] * v[2] + m[11] * v[3],
        m[12] * v[0] + m[13] * v[1] + m[14] * v[2] + m[15] * v[3]
      ];
    },
    dot(x, y) {
      return x[0] * y[0] + x[1] * y[1] + x[2] * y[2] + x[3] * y[3];
    },
    sml(a, y) {
      return [a * y[0], a * y[1], a * y[2], a * y[3]];
    }
  };
  function stats(nimg, i0, i1) {
    const R = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const m = [0, 0, 0, 0];
    const N = i1 - i0 >> 2;
    for (let i = i0; i < i1; i += 4) {
      const r = nimg[i] * (1 / 255);
      const g = nimg[i + 1] * (1 / 255);
      const b = nimg[i + 2] * (1 / 255);
      const a = nimg[i + 3] * (1 / 255);
      m[0] += r;
      m[1] += g;
      m[2] += b;
      m[3] += a;
      R[0] += r * r;
      R[1] += r * g;
      R[2] += r * b;
      R[3] += r * a;
      R[5] += g * g;
      R[6] += g * b;
      R[7] += g * a;
      R[10] += b * b;
      R[11] += b * a;
      R[15] += a * a;
    }
    R[4] = R[1];
    R[8] = R[2];
    R[9] = R[6];
    R[12] = R[3];
    R[13] = R[7];
    R[14] = R[11];
    return { R, m, N };
  }
  function estats(st) {
    const R = st.R;
    const m = st.m;
    const N = st.N;
    const m0 = m[0];
    const m1 = m[1];
    const m2 = m[2];
    const m3 = m[3];
    const iN = N === 0 ? 0 : 1 / N;
    const Rj = [
      R[0] - m0 * m0 * iN,
      R[1] - m0 * m1 * iN,
      R[2] - m0 * m2 * iN,
      R[3] - m0 * m3 * iN,
      R[4] - m1 * m0 * iN,
      R[5] - m1 * m1 * iN,
      R[6] - m1 * m2 * iN,
      R[7] - m1 * m3 * iN,
      R[8] - m2 * m0 * iN,
      R[9] - m2 * m1 * iN,
      R[10] - m2 * m2 * iN,
      R[11] - m2 * m3 * iN,
      R[12] - m3 * m0 * iN,
      R[13] - m3 * m1 * iN,
      R[14] - m3 * m2 * iN,
      R[15] - m3 * m3 * iN
    ];
    let b = [Math.random(), Math.random(), Math.random(), Math.random()];
    let mi = 0;
    let tmi = 0;
    if (N !== 0) {
      for (let i = 0; i < 16; i++) {
        b = M4.multVec(Rj, b);
        tmi = Math.sqrt(M4.dot(b, b));
        b = M4.sml(1 / tmi, b);
        if (i !== 0 && Math.abs(tmi - mi) < 1e-9) break;
        mi = tmi;
      }
    }
    const q = [m0 * iN, m1 * iN, m2 * iN, m3 * iN];
    const eMq255 = M4.dot(M4.sml(255, q), b);
    return {
      Cov: Rj,
      q,
      e: b,
      L: mi,
      eMq255,
      eMq: M4.dot(b, q),
      rgba: (Math.round(255 * q[3]) << 24 | Math.round(255 * q[2]) << 16 | Math.round(255 * q[1]) << 8 | Math.round(255 * q[0])) >>> 0
    };
  }
  function vecDot(nimg, i, e) {
    return nimg[i] * e[0] + nimg[i + 1] * e[1] + nimg[i + 2] * e[2] + nimg[i + 3] * e[3];
  }
  function splitPixels(nimg, nimg32, i0, i1, e, eMq) {
    i1 -= 4;
    while (i0 < i1) {
      while (vecDot(nimg, i0, e) <= eMq) i0 += 4;
      while (vecDot(nimg, i1, e) > eMq) i1 -= 4;
      if (i0 >= i1) break;
      const t = nimg32[i0 >> 2];
      nimg32[i0 >> 2] = nimg32[i1 >> 2];
      nimg32[i1 >> 2] = t;
      i0 += 4;
      i1 -= 4;
    }
    while (vecDot(nimg, i0, e) > eMq) i0 -= 4;
    return i0 + 4;
  }
  function planeDst(est, r, g, b, a) {
    const e = est.e;
    return e[0] * r + e[1] * g + e[2] * b + e[3] * a - est.eMq;
  }
  function dist(q, r, g, b, a) {
    const d0 = r - q[0];
    const d1 = g - q[1];
    const d2 = b - q[2];
    const d3 = a - q[3];
    return d0 * d0 + d1 * d1 + d2 * d2 + d3 * d3;
  }
  function makeNode(i0, i1, bst) {
    return {
      i0,
      i1,
      bst,
      est: estats(bst),
      tdst: 0,
      ind: 0,
      left: null,
      right: null
    };
  }
  function getKDtree(nimg, ps, err2 = 1e-4) {
    const nimg32 = new Uint32Array(nimg.buffer);
    const root = makeNode(0, nimg.length, stats(nimg, 0, nimg.length));
    const leafs = [root];
    while (leafs.length < ps) {
      let maxL = 0;
      let mi = 0;
      for (let i = 0; i < leafs.length; i++) {
        if (leafs[i].est.L > maxL) {
          maxL = leafs[i].est.L;
          mi = i;
        }
      }
      if (maxL < err2) break;
      const node = leafs[mi];
      const s0 = splitPixels(
        nimg,
        nimg32,
        node.i0,
        node.i1,
        node.est.e,
        node.est.eMq255
      );
      if (node.i0 >= s0 || node.i1 <= s0) {
        node.est.L = 0;
        continue;
      }
      const ln2 = makeNode(node.i0, s0, stats(nimg, node.i0, s0));
      const rbst = { R: [], m: [], N: node.bst.N - ln2.bst.N };
      for (let i = 0; i < 16; i++) rbst.R[i] = node.bst.R[i] - ln2.bst.R[i];
      for (let i = 0; i < 4; i++) rbst.m[i] = node.bst.m[i] - ln2.bst.m[i];
      const rn = makeNode(s0, node.i1, rbst);
      node.left = ln2;
      node.right = rn;
      leafs[mi] = ln2;
      leafs.push(rn);
    }
    leafs.sort((a, b) => b.bst.N - a.bst.N);
    for (let i = 0; i < leafs.length; i++) leafs[i].ind = i;
    return [root, leafs];
  }
  function getNearest(nd, r, g, b, a) {
    if (nd.left === null) {
      nd.tdst = dist(nd.est.q, r, g, b, a);
      return nd;
    }
    const pd = planeDst(nd.est, r, g, b, a);
    let node0 = nd.left;
    let node1 = nd.right;
    if (pd > 0) {
      node0 = nd.right;
      node1 = nd.left;
    }
    const ln2 = getNearest(node0, r, g, b, a);
    if (ln2.tdst <= pd * pd) return ln2;
    const rn = getNearest(node1, r, g, b, a);
    return rn.tdst < ln2.tdst ? rn : ln2;
  }
  function remap(inds, tb32, pl32) {
    for (let i = 0; i < inds.length; i++) tb32[i] = pl32[inds[i]];
  }
  function updatePalette(sb, inds, plte) {
    const K = plte.length >>> 2;
    const sums = new Uint32Array(K * 4);
    const cnts = new Uint32Array(K);
    for (let i = 0; i < sb.length; i += 4) {
      const ind = inds[i >>> 2];
      const qi = ind * 4;
      cnts[ind]++;
      sums[qi] += sb[i];
      sums[qi + 1] += sb[i + 1];
      sums[qi + 2] += sb[i + 2];
      sums[qi + 3] += sb[i + 3];
    }
    for (let i = 0; i < plte.length; i++) {
      plte[i] = Math.round(sums[i] / cnts[i >>> 2]);
    }
  }
  function findNearest(sb, inds, plte) {
    let terr = 0;
    const K = plte.length >>> 2;
    const nd = [];
    for (let i = 0; i < K; i++) {
      const qi = i * 4;
      const r = plte[qi];
      const g = plte[qi + 1];
      const b = plte[qi + 2];
      const a = plte[qi + 3];
      let te = 1e9;
      for (let j = 0; j < K; j++) {
        if (i === j) continue;
        const qj = j * 4;
        const dr = r - plte[qj];
        const dg = g - plte[qj + 1];
        const db = b - plte[qj + 2];
        const da = a - plte[qj + 3];
        const err2 = dr * dr + dg * dg + db * db + da * da;
        if (err2 < te) te = err2;
      }
      const hd = Math.sqrt(te) * 0.5;
      nd[i] = hd * hd;
    }
    for (let i = 0; i < sb.length; i += 4) {
      const r = sb[i];
      const g = sb[i + 1];
      const b = sb[i + 2];
      const a = sb[i + 3];
      let ti = inds[i >>> 2];
      let qi = ti * 4;
      let dr = r - plte[qi];
      let dg = g - plte[qi + 1];
      let db = b - plte[qi + 2];
      let da = a - plte[qi + 3];
      let te = dr * dr + dg * dg + db * db + da * da;
      if (te > nd[ti]) {
        for (let j = 0; j < K; j++) {
          qi = j * 4;
          dr = r - plte[qi];
          dg = g - plte[qi + 1];
          db = b - plte[qi + 2];
          da = a - plte[qi + 3];
          const err2 = dr * dr + dg * dg + db * db + da * da;
          if (err2 < te) {
            te = err2;
            ti = j;
            if (te < nd[j]) break;
          }
        }
      }
      inds[i >>> 2] = ti;
      terr += te;
    }
    return terr / (sb.length >>> 2);
  }
  function kmeans(sb, inds, plte) {
    updatePalette(sb, inds, plte);
    return findNearest(sb, inds, plte);
  }
  function quantize(abuf, ps, doKmeans) {
    const sb = new Uint8Array(abuf);
    const tb = sb.slice(0);
    const tb32 = new Uint32Array(tb.buffer);
    const [root, leafs] = getKDtree(tb, ps);
    const K = leafs.length;
    const cl32 = new Uint32Array(K);
    const clr8 = new Uint8Array(cl32.buffer);
    for (let i = 0; i < K; i++) cl32[i] = leafs[i].est.rgba;
    const len = sb.length;
    const inds = new Uint8Array(len >> 2);
    if (K <= 60) {
      findNearest(sb, inds, clr8);
      remap(inds, tb32, cl32);
    } else if (len < 32e6) {
      for (let i = 0; i < len; i += 4) {
        const nd = getNearest(
          root,
          sb[i] * (1 / 255),
          sb[i + 1] * (1 / 255),
          sb[i + 2] * (1 / 255),
          sb[i + 3] * (1 / 255)
        );
        inds[i >> 2] = nd.ind;
        tb32[i >> 2] = nd.est.rgba;
      }
    } else {
      for (let i = 0; i < len; i += 4) {
        const r = sb[i] * (1 / 255);
        const g = sb[i + 1] * (1 / 255);
        const b = sb[i + 2] * (1 / 255);
        const a = sb[i + 3] * (1 / 255);
        let nd = root;
        while (nd.left) {
          nd = planeDst(nd.est, r, g, b, a) <= 0 ? nd.left : nd.right;
        }
        inds[i >> 2] = nd.ind;
        tb32[i >> 2] = nd.est.rgba;
      }
    }
    if (doKmeans || len * K < 10 * 4e6) {
      let le = 1e9;
      for (let i = 0; i < 10; i++) {
        const ce = kmeans(sb, inds, clr8);
        if (ce / le > 0.997) break;
        le = ce;
      }
      for (let i = 0; i < K; i++) leafs[i].est.rgba = cl32[i];
      remap(inds, tb32, cl32);
    }
    return { abuf: tb.buffer, inds, plte: leafs };
  }

  // encode.ts
  function filterAndCompress(img, h, bpp, bpl, filter, levelZero) {
    const data = new Uint8Array(h * bpl + h);
    let ftry = [0, 1, 2, 3, 4];
    if (filter !== -1) ftry = [filter];
    else if (h * bpl > 5e5 || bpp === 1) ftry = [0];
    const opts = levelZero ? { level: 0 } : {};
    const fls = [];
    for (let i = 0; i < ftry.length; i++) {
      for (let y = 0; y < h; y++) {
        filterLine(data, img, y, bpl, bpp, ftry[i]);
      }
      fls.push(zlibSync(data, opts));
    }
    let ti = 0;
    let tsize = 1e9;
    for (let i = 0; i < fls.length; i++) {
      if (fls[i].length < tsize) {
        ti = i;
        tsize = fls[i].length;
      }
    }
    return fls[ti];
  }
  function compressPNG(nimg, filter, levelZero = false) {
    for (const frm of nimg.frames) {
      const nh = frm.rect.height;
      frm.cimg = filterAndCompress(
        frm.img,
        nh,
        frm.bpp,
        frm.bpl,
        filter,
        levelZero
      );
    }
  }
  function writePNG(nimg, w, h, dels, tabs) {
    var _a2, _b2;
    if (tabs === void 0) tabs = {};
    const anim = nimg.frames.length > 1;
    let pltAlpha = false;
    let leng = 8 + (16 + 5 + 4) + (anim ? 20 : 0);
    if (tabs.sRGB !== void 0) leng += 8 + 1 + 4;
    if (tabs.pHYs !== void 0) leng += 8 + 9 + 4;
    if (nimg.ctype === 3 && nimg.plte) {
      const dl = nimg.plte.length;
      for (let i = 0; i < dl; i++) {
        if (nimg.plte[i] >>> 24 !== 255) pltAlpha = true;
      }
      leng += 8 + dl * 3 + 4 + (pltAlpha ? 8 + dl * 1 + 4 : 0);
    }
    for (let j = 0; j < nimg.frames.length; j++) {
      const fr = nimg.frames[j];
      if (anim) leng += 38;
      leng += fr.cimg.length + 12;
      if (j !== 0) leng += 4;
    }
    leng += 12;
    const data = new Uint8Array(leng);
    const sig = [137, 80, 78, 71, 13, 10, 26, 10];
    for (let i = 0; i < 8; i++) data[i] = sig[i];
    let offset = 8;
    writeUint(data, offset, 13);
    offset += 4;
    writeASCII(data, offset, "IHDR");
    offset += 4;
    writeUint(data, offset, w);
    offset += 4;
    writeUint(data, offset, h);
    offset += 4;
    data[offset++] = nimg.depth;
    data[offset++] = nimg.ctype;
    data[offset++] = 0;
    data[offset++] = 0;
    data[offset++] = 0;
    writeUint(data, offset, crc(data, offset - 17, 17));
    offset += 4;
    if (tabs.sRGB !== void 0) {
      writeUint(data, offset, 1);
      offset += 4;
      writeASCII(data, offset, "sRGB");
      offset += 4;
      data[offset++] = tabs.sRGB;
      writeUint(data, offset, crc(data, offset - 5, 5));
      offset += 4;
    }
    if (tabs.pHYs !== void 0) {
      writeUint(data, offset, 9);
      offset += 4;
      writeASCII(data, offset, "pHYs");
      offset += 4;
      writeUint(data, offset, tabs.pHYs[0]);
      offset += 4;
      writeUint(data, offset, tabs.pHYs[1]);
      offset += 4;
      data[offset++] = tabs.pHYs[2];
      writeUint(data, offset, crc(data, offset - 13, 13));
      offset += 4;
    }
    if (anim) {
      writeUint(data, offset, 8);
      offset += 4;
      writeASCII(data, offset, "acTL");
      offset += 4;
      writeUint(data, offset, nimg.frames.length);
      offset += 4;
      writeUint(data, offset, (_a2 = tabs.loop) != null ? _a2 : 0);
      offset += 4;
      writeUint(data, offset, crc(data, offset - 12, 12));
      offset += 4;
    }
    if (nimg.ctype === 3 && nimg.plte) {
      const dl = nimg.plte.length;
      writeUint(data, offset, dl * 3);
      offset += 4;
      writeASCII(data, offset, "PLTE");
      offset += 4;
      for (let i = 0; i < dl; i++) {
        const ti = i * 3;
        const c = nimg.plte[i];
        data[offset + ti] = c & 255;
        data[offset + ti + 1] = c >>> 8 & 255;
        data[offset + ti + 2] = c >>> 16 & 255;
      }
      offset += dl * 3;
      writeUint(data, offset, crc(data, offset - dl * 3 - 4, dl * 3 + 4));
      offset += 4;
      if (pltAlpha) {
        writeUint(data, offset, dl);
        offset += 4;
        writeASCII(data, offset, "tRNS");
        offset += 4;
        for (let i = 0; i < dl; i++) {
          data[offset + i] = nimg.plte[i] >>> 24 & 255;
        }
        offset += dl;
        writeUint(data, offset, crc(data, offset - dl - 4, dl + 4));
        offset += 4;
      }
    }
    let fi = 0;
    for (let j = 0; j < nimg.frames.length; j++) {
      const fr = nimg.frames[j];
      if (anim) {
        writeUint(data, offset, 26);
        offset += 4;
        writeASCII(data, offset, "fcTL");
        offset += 4;
        writeUint(data, offset, fi++);
        offset += 4;
        writeUint(data, offset, fr.rect.width);
        offset += 4;
        writeUint(data, offset, fr.rect.height);
        offset += 4;
        writeUint(data, offset, fr.rect.x);
        offset += 4;
        writeUint(data, offset, fr.rect.y);
        offset += 4;
        writeUshort(data, offset, (_b2 = dels == null ? void 0 : dels[j]) != null ? _b2 : 0);
        offset += 2;
        writeUshort(data, offset, 1e3);
        offset += 2;
        data[offset++] = fr.dispose;
        data[offset++] = fr.blend;
        writeUint(data, offset, crc(data, offset - 30, 30));
        offset += 4;
      }
      const imgd = fr.cimg;
      const dl = imgd.length;
      writeUint(data, offset, dl + (j === 0 ? 0 : 4));
      offset += 4;
      const ioff = offset;
      writeASCII(data, offset, j === 0 ? "IDAT" : "fdAT");
      offset += 4;
      if (j !== 0) {
        writeUint(data, offset, fi++);
        offset += 4;
      }
      data.set(imgd, offset);
      offset += dl;
      writeUint(data, offset, crc(data, ioff, offset - ioff));
      offset += 4;
    }
    writeUint(data, offset, 0);
    offset += 4;
    writeASCII(data, offset, "IEND");
    offset += 4;
    writeUint(data, offset, crc(data, offset - 4, 4));
    offset += 4;
    return data.buffer;
  }
  function packIndexed(inds, nw, nh, depth) {
    const bpl = Math.ceil(depth * nw / 8);
    const nimg = new Uint8Array(bpl * nh);
    for (let y = 0; y < nh; y++) {
      const i = y * bpl;
      const ii = y * nw;
      if (depth === 8) {
        for (let x = 0; x < nw; x++) nimg[i + x] = inds[ii + x];
      } else if (depth === 4) {
        for (let x = 0; x < nw; x++) {
          nimg[i + (x >> 1)] |= inds[ii + x] << 4 - (x & 1) * 4;
        }
      } else if (depth === 2) {
        for (let x = 0; x < nw; x++) {
          nimg[i + (x >> 2)] |= inds[ii + x] << 6 - (x & 3) * 2;
        }
      } else if (depth === 1) {
        for (let x = 0; x < nw; x++) {
          nimg[i + (x >> 3)] |= inds[ii + x] << 7 - (x & 7);
        }
      }
    }
    return nimg;
  }
  function compress(bufs, w, h, ps, prms) {
    const [onlyBlend, evenCrd, forbidPrev, minBits, forbidPlte, dith] = prms;
    let ctype = 6;
    let depth = 8;
    let alphaAnd = 255;
    for (let j = 0; j < bufs.length; j++) {
      const img = new Uint8Array(bufs[j]);
      for (let i = 0; i < img.length; i += 4) alphaAnd &= img[i + 3];
    }
    const gotAlpha = alphaAnd !== 255;
    const frms = framize(bufs, w, h, onlyBlend, evenCrd, forbidPrev);
    const plte = [];
    const inds = [];
    if (ps !== 0) {
      const nbufs = [];
      for (let i = 0; i < frms.length; i++) {
        nbufs.push(frms[i].img.buffer);
      }
      const qres = quantize(concatRGBA(nbufs), ps);
      for (let i = 0; i < qres.plte.length; i++) plte.push(qres.plte[i].est.rgba);
      let cof = 0;
      for (let i = 0; i < frms.length; i++) {
        const frm = frms[i];
        const bln = frm.img.length;
        const ind = new Uint8Array(qres.inds.buffer, cof >> 2, bln >> 2);
        inds.push(ind);
        const bb = new Uint8Array(qres.abuf, cof, bln);
        if (dith) {
          dither(frm.img, frm.rect.width, frm.rect.height, plte, bb, ind);
        }
        frm.img.set(bb);
        cof += bln;
      }
    } else {
      const cmap = /* @__PURE__ */ new Map();
      for (let j = 0; j < frms.length; j++) {
        const frm = frms[j];
        const img32 = new Uint32Array(frm.img.buffer);
        const nw = frm.rect.width;
        const ilen = img32.length;
        const ind = new Uint8Array(ilen);
        inds.push(ind);
        for (let i = 0; i < ilen; i++) {
          const c = img32[i];
          if (i !== 0 && c === img32[i - 1]) ind[i] = ind[i - 1];
          else if (i > nw && c === img32[i - nw]) ind[i] = ind[i - nw];
          else {
            let cmc = cmap.get(c);
            if (cmc === void 0) {
              cmc = plte.length;
              cmap.set(c, cmc);
              plte.push(c);
              if (plte.length >= 300) break;
            }
            ind[i] = cmc;
          }
        }
      }
    }
    const cc = plte.length;
    const usePlte = cc <= 256 && !forbidPlte;
    if (usePlte) {
      if (cc <= 2) depth = 1;
      else if (cc <= 4) depth = 2;
      else if (cc <= 16) depth = 4;
      else depth = 8;
      depth = Math.max(depth, minBits);
    }
    const frames = [];
    for (let j = 0; j < frms.length; j++) {
      const frm = frms[j];
      const nw = frm.rect.width;
      const nh = frm.rect.height;
      let cimg = frm.img;
      let bpl = 4 * nw;
      let bpp = 4;
      if (usePlte) {
        bpl = Math.ceil(depth * nw / 8);
        cimg = packIndexed(inds[j], nw, nh, depth);
        ctype = 3;
        bpp = 1;
      } else if (!gotAlpha && frms.length === 1) {
        const nimg = new Uint8Array(nw * nh * 3);
        const area = nw * nh;
        for (let i = 0; i < area; i++) {
          const ti = i * 3;
          const qi = i * 4;
          nimg[ti] = cimg[qi];
          nimg[ti + 1] = cimg[qi + 1];
          nimg[ti + 2] = cimg[qi + 2];
        }
        cimg = nimg;
        ctype = 2;
        bpp = 3;
        bpl = 3 * nw;
      }
      frames.push({
        rect: frm.rect,
        img: cimg,
        blend: frm.blend,
        dispose: frm.dispose,
        bpp,
        bpl
      });
    }
    return { ctype, depth, plte, frames };
  }
  function encode(imgs, w, h, cnum = 0, dels, tabs, forbidPlte = false) {
    const nimg = compress(imgs, w, h, cnum, [
      false,
      false,
      false,
      0,
      forbidPlte,
      false
    ]);
    compressPNG(nimg, -1);
    return writePNG(nimg, w, h, dels, tabs);
  }
  function encodeLL(imgs, w, h, cc, ac, depth, dels, tabs) {
    const nimg = {
      ctype: 0 + (cc === 1 ? 0 : 2) + (ac === 0 ? 0 : 4),
      depth,
      frames: []
    };
    const bipp = (cc + ac) * depth;
    const bipl = bipp * w;
    for (let i = 0; i < imgs.length; i++) {
      nimg.frames.push({
        rect: { x: 0, y: 0, width: w, height: h },
        img: new Uint8Array(imgs[i]),
        blend: 0,
        dispose: 1,
        bpp: Math.ceil(bipp / 8),
        bpl: Math.ceil(bipl / 8)
      });
    }
    compressPNG(nimg, 0, true);
    return writePNG(nimg, w, h, dels, tabs);
  }

  // index.ts
  var UPNG = {
    decode,
    toRGBA8,
    encode,
    encodeLL,
    quantize,
    compress,
    dither
  };
  var index_default = UPNG;
  return __toCommonJS(index_exports);
})();
UPNG = UPNG.default ?? UPNG;
if (typeof module === "object" && module.exports) {
  module.exports = UPNG;
}
if (typeof define === "function" && define.amd) {
  define(function () { return UPNG; });
}
//# sourceMappingURL=index.umd.js.map
