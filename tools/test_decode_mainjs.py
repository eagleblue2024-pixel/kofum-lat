import importlib.util
import json
import sys
import types
import unittest
from unittest.mock import patch

fake=types.ModuleType('analyze_mainjs')
fake.fetch_text=lambda *args:None
fake.analyze=lambda fetch:{'status':'blocked_or_unsupported'}
fake.inspect_script=lambda source:{'literal_lists':{}}
sys.modules['analyze_mainjs']=fake
spec=importlib.util.spec_from_file_location('decoder','tools/decode_mainjs.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

def lists():
    return {'main':{'status':'literal_domains','domains':['medixiru.com']},'dmca':{'status':'literal_domains','domains':['niramirus.com']},'rules':{'status':'literal_domains','domains':['streamwish.to']}}

class DecodeTests(unittest.TestCase):
    def test_main_selection(self):
        self.assertEqual(m.route_preview(lists(),'streamwish.to')['selected_list'],'main')
    def test_dmca_selection(self):
        self.assertEqual(m.route_preview(lists(),'streamwish.com')['selected_list'],'dmca')
    def test_incomplete_configuration(self):
        self.assertEqual(m.route_preview({},'streamwish.to')['status'],'configuration_still_not_literal')
    def test_unavailable_source_does_not_transform(self):
        decoder=lambda _:self.fail('must not transform')
        self.assertEqual(m.analyze(decoder=decoder)['status'],'source_unavailable')
    def source(self,fetch):
        fetch('https://streamwish.to/main.js',{'streamwish.to'},'ref','main_script',[])
        return {'status':'static_inspection_complete','server_host':'streamwish.to'}
    def test_orchestration_without_exposing_source(self):
        with patch.object(fake,'analyze',side_effect=self.source),patch.object(fake,'inspect_script',return_value={'literal_lists':lists()}):
            report=m.analyze(fetch=lambda *args:'secret-source-body',decoder=lambda source:'secret-decoded-body')
        self.assertEqual(report['status'],'literal_routes_recovered')
        self.assertNotIn('secret-',json.dumps(report))
    def test_unrecognized_exception_is_sanitized(self):
        def decoder(_):raise RuntimeError('https://secret.net/path?token=private')
        with patch.object(fake,'analyze',side_effect=self.source):
            report=m.analyze(fetch=lambda *args:'source',decoder=decoder)
        self.assertEqual(report['error'],'transform_or_parse_failed')
        self.assertNotIn('secret.net',json.dumps(report))
    def test_known_failure_code(self):
        def decoder(_):raise m.TransformFailure('transform_timeout')
        with patch.object(fake,'analyze',side_effect=self.source):
            report=m.analyze(fetch=lambda *args:'source',decoder=decoder)
        self.assertEqual(report['error'],'transform_timeout')
    def test_no_claim_of_recovered_routes(self):
        with patch.object(fake,'analyze',side_effect=self.source),patch.object(fake,'inspect_script',return_value={'literal_lists':{}}):
            report=m.analyze(fetch=lambda *args:'source',decoder=lambda _: 'transformed')
        self.assertEqual(report['status'],'deobfuscation_incomplete')
    def test_missing_dependency_tools(self):
        with patch.object(m.shutil,'which',return_value=None):
            with self.assertRaises(m.TransformFailure):m.decode_local('source')
    def test_install_disables_scripts_and_omits_credentials(self):
        recorded=[]
        def run(args,**kwargs):
            recorded.append((args,kwargs))
            return types.SimpleNamespace(returncode=1)
        with patch.object(m.shutil,'which',side_effect=lambda name:'/usr/bin/'+name),patch.object(m.subprocess,'run',side_effect=run):
            with self.assertRaises(m.TransformFailure):m.decode_local('source')
        args,options=recorded[0]
        self.assertIn('--ignore-scripts',args)
        self.assertEqual(set(options['env']),{'PATH','HOME','TMPDIR','CI'})
        self.assertEqual(options['timeout'],90)

if __name__=='__main__':unittest.main()
