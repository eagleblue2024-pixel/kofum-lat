"""Offline AST transformation on an ephemeral runner; publish metadata only."""
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
import analyze_mainjs as base

PACKAGE = 'deobfuscator@2.4.6'
VERSION = '2.4.6'
NODE_RUNNER = r"""
'use strict';
const fs = require('node:fs');
console.log = console.warn = console.error = () => {};
(async () => {
  const modulePath = process.argv[2];
  if (require(modulePath + '/package.json').version !== '2.4.6') throw Error('version_mismatch');
  const { Deobfuscator } = require(modulePath);
  const acorn = require(require.resolve('acorn', {paths:[modulePath]}));
  const generate = require(require.resolve('@javascript-obfuscator/escodegen', {paths:[modulePath]}));
  const { inspectAst, normalize, selfTest } = require(process.argv[5]);
  selfTest();
  function parse(text) {try{return acorn.parse(text,{ecmaVersion:'latest',sourceType:'script'});}catch(_){return acorn.parse(text,{ecmaVersion:'latest',sourceType:'module'});}}
  const tool = new Deobfuscator();
  const marker = '__kofum_sample_must_not_execute__';
  delete globalThis[marker];
  const fixture = 'globalThis.__kofum_sample_must_not_execute__ = true; const main = ["medixiru.com"]; console.log(main);';
  const checked = await tool.deobfuscateSource(fixture, {rename:false, loose:false});
  if (globalThis[marker] !== undefined || typeof checked !== 'string' || !checked.includes('medixiru.com')) throw Error('static_selftest_failed');
  const source = fs.readFileSync(process.argv[3], 'utf8');
  const ast = parse(source);
  const originalExpressions = inspectAst(ast);
  const normalization = normalize(ast);
  const normalizedSource = generate.generate(ast);
  const result = await tool.deobfuscateSource(normalizedSource, {rename:false, loose:false});
  if (typeof result !== 'string' || Buffer.byteLength(result, 'utf8') > 3000000) throw Error('output_too_large');
  fs.writeFileSync(process.argv[4], result, {mode:0o600});
  const expressions = {original:originalExpressions,normalization,transformed:inspectAst(parse(result))};
  const encoded = JSON.stringify(expressions);
  if (Buffer.byteLength(encoded,'utf8') > 1000000) throw Error('expression_report_too_large');
  fs.writeFileSync(process.argv[6],encoded,{mode:0o600});
})().catch(() => { process.exitCode = 2; });
"""

class TransformFailure(Exception):
    pass

class DecodedText(str):
    def __new__(cls, text, expressions):
        value = super().__new__(cls,text)
        value.expression_analysis = expressions
        return value


def decode_local(source):
    npm, node = shutil.which('npm'), shutil.which('node')
    if not npm or not node:
        raise TransformFailure('dependency_tool_missing')
    with tempfile.TemporaryDirectory(prefix='kofum-static-') as directory:
        work = Path(directory)
        environment = {'PATH':os.environ.get('PATH',''),'HOME':directory,'TMPDIR':directory,'CI':'true'}
        try:
            install = subprocess.run(
                [npm,'install','--ignore-scripts','--no-audit','--no-fund','--prefix',directory,PACKAGE],
                cwd=directory,env=environment,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=90)
        except subprocess.TimeoutExpired:
            raise TransformFailure('dependency_install_timeout') from None
        if install.returncode:
            raise TransformFailure('dependency_install_failed')
        input_path, output_path = work/'input.js',work/'decoded.js'
        expression_path = work/'expressions.json'
        helper = Path(__file__).with_name('route_ast.cjs').resolve()
        wrapper = work/'transform.cjs'
        input_path.write_text(source,encoding='utf-8')
        input_path.chmod(0o600)
        wrapper.write_text(NODE_RUNNER,encoding='utf-8')
        try:
            result = subprocess.run(
                [node,'--max-old-space-size=256',str(wrapper),str(work/'node_modules/deobfuscator'),str(input_path),str(output_path),str(helper),str(expression_path)],
                cwd=directory,env=environment,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=30)
        except subprocess.TimeoutExpired:
            raise TransformFailure('transform_timeout') from None
        if result.returncode or not output_path.exists() or not expression_path.exists():
            raise TransformFailure('transform_or_selftest_failed')
        if output_path.stat().st_size > 3000000 or expression_path.stat().st_size > 1000000:
            raise TransformFailure('output_too_large')
        return DecodedText(output_path.read_text(encoding='utf-8'),json.loads(expression_path.read_text(encoding='utf-8')))


def route_preview(lists, host):
    if any(lists.get(name,{}).get('status') != 'literal_domains' for name in ('main','dmca','rules')):
        return {'status':'configuration_still_not_literal'}
    route = 'main' if host in lists['rules'].get('domains',[]) else 'dmca'
    candidates = lists[route].get('domains',[])
    return {'status':'literal_configuration_recovered','selected_list':route,'candidate_domains':candidates,
            'note':'No target was requested. No video identifier was migrated or tested. Playback unverified.'}


def analyze(fetch=base.fetch_text, decoder=decode_local):
    captured = {}
    def capture(url, hosts, referer, stage, events):
        text = fetch(url,hosts,referer,stage,events)
        if stage == 'main_script':
            captured['script'] = text
        return text
    source_report = base.analyze(capture)
    report = {'tool':PACKAGE,'method':'Restricted AST forwarding-call normalization and transformation; no execution of the complete source script.',
              'source_inspection':source_report,'status':'not_completed'}
    if source_report.get('status') != 'static_inspection_complete' or 'script' not in captured:
        report['status'] = 'source_unavailable'
        return report
    try:
        decoded = decoder(captured['script'])
        decoded_report = base.inspect_script(decoded)
        report['decoded_inspection'] = decoded_report
        report['expression_analysis'] = getattr(decoded,'expression_analysis',{})
        report['routing'] = route_preview(decoded_report.get('literal_lists',{}),source_report.get('server_host',''))
        report['status'] = 'literal_routes_recovered' if report['routing']['status']=='literal_configuration_recovered' else 'deobfuscation_incomplete'
    except Exception as error:
        report['status'] = 'transform_failed'
        allowed = {'dependency_tool_missing','dependency_install_timeout','dependency_install_failed','transform_timeout','transform_or_selftest_failed','output_too_large'}
        code = str(error) if isinstance(error,TransformFailure) else ''
        report['error'] = code if code in allowed else 'transform_or_parse_failed'
    finally:
        captured.clear()
    return report


if __name__ == '__main__':
    target = Path('analysis/mainjs-decoded-report.json')
    target.parent.mkdir(exist_ok=True)
    target.write_text(json.dumps(analyze(),ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
