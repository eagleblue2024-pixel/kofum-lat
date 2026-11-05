"""Launch adapter with sandbox enforcement and redacted diagnostics only."""
import asyncio
import json
import os
import re
import shutil
import sys
import tempfile
from pathlib import Path

SAFE_ARGS={'--disable-background-networking','--disable-component-update','--force-webrtc-ip-handling-policy=disable_non_proxied_udp'}
class BrowserLaunchPolicyError(Exception):pass
class SandboxedLaunchFailed(Exception):pass

def launch_error(error):
    text=str(error).lower()
    if 'no usable sandbox' in text or 'failed to move to new namespace' in text or 'failed to unshare' in text or 'operation not permitted' in text and 'namespace' in text:
        code='sandbox_namespace_restriction'
    elif 'running as root' in text:code='root_user_sandbox_restriction'
    elif 'error while loading shared libraries' in text:code='missing_shared_library'
    elif "executable doesn't exist" in text or 'executable does not exist' in text:code='browser_binary_missing'
    elif 'permission denied' in text:code='launch_permission_denied'
    elif 'crashpad' in text and 'database' in text:code='crashpad_configuration'
    elif 'devtoolsactiveport' in text:code='devtools_endpoint_missing'
    else:code='launch_failure_unclassified'
    result={'code':code,'error_class':type(error).__name__ if re.fullmatch(r'[A-Za-z_]{1,60}',type(error).__name__) else 'redacted_error'}
    signal=re.search(r'\bsignal=(SIG[A-Z]{1,10})\b',str(error))
    exit_code=re.search(r'\bexitCode=(-?\d{1,5})\b',str(error))
    if signal:result['signal']=signal[1]
    if exit_code:result['exit_code']=int(exit_code[1])
    return result

def prepare_environment():
    temporary=Path(os.environ.get('TMPDIR') or tempfile.gettempdir()).resolve()
    home=Path(os.environ.get('HOME','')).resolve()
    if not home.is_relative_to(temporary):raise BrowserLaunchPolicyError('temporary_home_required')
    for name,path in {'XDG_CACHE_HOME':home/'.cache','XDG_CONFIG_HOME':home/'.config','XDG_RUNTIME_DIR':temporary/'kofum-browser-runtime'}.items():
        path.mkdir(parents=True,exist_ok=True,mode=0o700);path.chmod(0o700);os.environ[name]=str(path)

def environment_report(system_chrome):
    report={'sandbox_enforced':True,'no_unsandboxed_fallback':True,'system_chrome_available':bool(system_chrome),
            'running_as_root':os.geteuid()==0 if hasattr(os,'geteuid') else None,
            'home_writable':os.access(os.environ.get('HOME',''),os.W_OK),
            'temporary_runtime_configured':all(name in os.environ for name in ('XDG_CACHE_HOME','XDG_CONFIG_HOME','XDG_RUNTIME_DIR'))}
    flag=Path('/proc/sys/kernel/apparmor_restrict_unprivileged_userns')
    try:
        value=flag.read_text().strip()
        if value in ('0','1'):report['os_user_namespace_restriction_flag']=int(value)
    except OSError:pass
    return report

def install_adapter(browser_type,attempts,system_chrome):
    original=browser_type.launch
    async def launch(self,*args,**kwargs):
        if args or getattr(self,'name','')!='chromium' or kwargs.get('headless') is not True or kwargs.get('chromium_sandbox') is not True:
            raise BrowserLaunchPolicyError('sandboxed_headless_chromium_required')
        if kwargs.get('channel') or kwargs.get('executable_path') or not set(kwargs.get('args') or []).issubset(SAFE_ARGS):
            raise BrowserLaunchPolicyError('unexpected_launch_configuration')
        candidates=[('system_chrome',system_chrome)] if system_chrome else []
        candidates.append(('bundled_chromium',None))
        for label,path in candidates:
            options=dict(kwargs);options['timeout']=12000;options['chromium_sandbox']=True
            if path:options['executable_path']=path
            entry={'candidate':label,'sandbox':True};attempts.append(entry)
            try:
                browser=await original(self,**options)
                entry['status']='started';return browser
            except asyncio.CancelledError:
                entry['status']='cancelled_by_overall_limit';raise
            except Exception as error:
                entry['status']='failed';entry['diagnostic']=launch_error(error)
        raise SandboxedLaunchFailed('all_sandboxed_candidates_failed')
    browser_type.launch=launch
    def restore():browser_type.launch=original
    return restore

async def run():
    attempts=[];system_chrome=shutil.which('google-chrome') or shutil.which('google-chrome-stable');restore=None
    report={'requested_slug':'the-mongoose','status':'launcher_setup_failed'}
    try:
        prepare_environment()
        from playwright.async_api import BrowserType
        import browser_routing as probe
        restore=install_adapter(BrowserType,attempts,system_chrome)
        report=await probe.run()
    except Exception as error:
        report['launcher_error']=launch_error(error)
    finally:
        if restore:restore()
    report['launcher_adapter']='sandboxed_chrome_preference_v1'
    report['launch_environment']=environment_report(system_chrome)
    report['launch_attempts']=attempts
    return report

async def adapter_tests():
    passed=0
    def fake(fail_system=False,fail_all=False):
        class FakeBrowser:
            name='chromium'
            def __init__(self):self.calls=[]
            async def launch(self,**kwargs):
                self.calls.append(kwargs)
                if fail_all or fail_system and kwargs.get('executable_path'):
                    raise RuntimeError('No usable sandbox! https://secret.net/private?token=key signal=SIGTRAP exitCode=1')
                return 'fake_browser'
        return FakeBrowser
    options={'headless':True,'chromium_sandbox':True,'timeout':25000,'args':list(SAFE_ARGS)}
    cls=fake();obj=cls();attempts=[];restore=install_adapter(cls,attempts,'/fixture/chrome')
    try:
        assert await obj.launch(**options)=='fake_browser';assert attempts[0]['candidate']=='system_chrome';passed+=1
        assert obj.calls[0]['chromium_sandbox'] is True;assert obj.calls[0]['timeout']==12000;passed+=1
    finally:restore()
    cls=fake(fail_system=True);obj=cls();attempts=[];restore=install_adapter(cls,attempts,'/fixture/chrome')
    try:
        assert await obj.launch(**options)=='fake_browser';assert [x['status'] for x in attempts]==['failed','started'];passed+=1
        assert all(x['chromium_sandbox'] is True for x in obj.calls);assert 'executable_path' not in obj.calls[1];passed+=1
        assert 'secret.net' not in json.dumps(attempts) and 'token=' not in json.dumps(attempts);passed+=1
    finally:restore()
    cls=fake(fail_all=True);obj=cls();attempts=[];restore=install_adapter(cls,attempts,None)
    try:
        try:await obj.launch(**options)
        except SandboxedLaunchFailed:assert len(obj.calls)==1;passed+=1
        else:raise AssertionError('failure not reported')
        try:await obj.launch(**{**options,'chromium_sandbox':False})
        except BrowserLaunchPolicyError:assert len(obj.calls)==1;passed+=1
        else:raise AssertionError('unsafe sandbox mode accepted')
        try:await obj.launch(**{**options,'args':['--no-sandbox']})
        except BrowserLaunchPolicyError:assert len(obj.calls)==1;passed+=1
        else:raise AssertionError('unsafe flag accepted')
    finally:restore()
    assert launch_error(RuntimeError('error while loading shared libraries: libtest.so'))['code']=='missing_shared_library';passed+=1
    assert launch_error(RuntimeError('unclassified https://private.net/path?token=secret'))=={'code':'launch_failure_unclassified','error_class':'RuntimeError'};passed+=1
    return{'passed':passed,'total':10,'scope':'Simulated browser launches and redaction checks; no real Chrome launch or playback verified.'}

if __name__=='__main__':
    if '--self-test' in sys.argv:print(json.dumps(asyncio.run(adapter_tests())))
    else:
        path=Path('analysis/browser-routing-report.json');path.parent.mkdir(exist_ok=True)
        path.write_text(json.dumps(asyncio.run(run()),ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
