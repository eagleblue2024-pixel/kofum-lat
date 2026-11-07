"""Report bounded decoder relationships through the existing static HTTPS inspection."""
import json
from pathlib import Path
import inspect_static_routes as previous

if __name__=='__main__':
    target=Path('analysis/decoder-relations-report.json')
    target.parent.mkdir(exist_ok=True)
    target.write_text(json.dumps({'status':'not_started'})+'\n',encoding='utf-8')
    previous.HELPER=Path(__file__).with_name('decoder_relations.cjs')
    report=previous.run()
    report['scope']='AST relationships only; no source functions executed, no destination contact, no keys, indices or source values published. Not a routing resolver or playback test.'
    target.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
