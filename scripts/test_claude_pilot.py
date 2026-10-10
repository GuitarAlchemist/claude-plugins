import importlib.util
import pathlib
import tempfile
import unittest
import json
import os
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('pilot', pathlib.Path(__file__).with_name('claude_pilot.py'))
p = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(p)

class PolicyTests(unittest.TestCase):
    def test_positive_number_and_immutable_sha(self):
        self.assertEqual(p.number('12'), 12)
        for value in ['0', '-1', '1/../2', '1;echo x']:
            with self.assertRaises(ValueError): p.number(value)
        for value in ['main', 'a' * 39, 'A' * 40]:
            with self.assertRaises(ValueError): p.sha(value)

    def test_only_human_writers(self):
        for permission in ['write', 'maintain', 'admin']:
            p.writer({'permission': permission}, {'type': 'User'})
        for permission in ['read', 'triage', 'none']:
            with self.assertRaises(ValueError): p.writer({'permission': permission}, {'type': 'User'})
        with self.assertRaises(ValueError): p.writer({'permission': 'admin'}, {'type': 'Bot'})

    def test_exact_head_and_repository(self):
        pr = {'state': 'open', 'head': {'sha': 'a' * 40, 'repo': {'full_name': p.REPO}}, 'base': {'ref': 'main', 'repo': {'full_name': p.REPO}}}
        p.review_target(pr, 'a' * 40, 'main')
        for bad in ['b' * 40, 'main']:
            with self.assertRaises(ValueError): p.review_target(pr, bad, 'main')
        pr['head']['repo']['full_name'] = 'someone/fork'
        with self.assertRaises(ValueError): p.review_target(pr, 'a' * 40, 'main')

    def test_path_escapes_and_workflow_edits_refused(self):
        for value in ['../x.ts', '/x.ts', 'plugins/fleet/../x.ts', 'plugins/fleet/a\\b.ts', 'plugins/fleet/C:/x.ts', '.github/workflows/x.yml', 'plugins/fleet/.claude/settings.json', 'plugins/fleet/package.json', 'plugins/fleet/.hidden.ts', 'plugins/other/x.ts']:
            with self.assertRaises(ValueError): p.allowed_path(value, 'fleet')
        self.assertEqual(p.allowed_path('plugins/fleet/src/x.test.ts', 'fleet'), 'plugins/fleet/src/x.test.ts')

    def test_bounded_proposal_no_duplicates(self):
        good = {'summary': 'small fix', 'changes': [{'path': 'plugins/fleet/x.ts', 'content': 'export {};\n'}]}
        self.assertEqual(len(p.validate_proposal(good, 'fleet')), 1)
        for bad in [dict(good, changes=good['changes'] * 2), dict(good, changes=[]), dict(good, changes=[{'path':'plugins/fleet/x.ts','content':'x' * 40001}])]:
            with self.assertRaises(ValueError): p.validate_proposal(bad, 'fleet')

    def test_apply_rejects_symlink_and_preserves_outside(self):
        with tempfile.TemporaryDirectory() as d:
            root = pathlib.Path(d)
            (root/'plugins/fleet').mkdir(parents=True)
            outside = root/'outside.ts'; outside.write_text('unchanged')
            try: (root/'plugins/fleet/link.ts').symlink_to(outside)
            except OSError: self.skipTest('platform denies creating symlink')
            with self.assertRaises(ValueError): p.apply_changes(root, [{'path':'plugins/fleet/link.ts','content':'bad'}])
            self.assertEqual(outside.read_text(), 'unchanged')

    def test_symlink_refused_without_platform_dependency(self):
        with tempfile.TemporaryDirectory() as d:
            with patch.object(pathlib.Path, 'is_symlink', return_value=True):
                with self.assertRaises(ValueError): p.apply_changes(pathlib.Path(d), [{'path':'plugins/fleet/a.ts','content':'bad'}])

    def test_review_bounded_comment_and_no_approval(self):
        r = {'tldr': 'reviewed', 'verdict': 'changes_requested', 'checklist': [{'evidence':'x.ts:1', 'result':'not tested'}]}
        body = p.review_comment(r, 'a' * 40)
        self.assertIn('a' * 40, body)
        self.assertIn('not tested', body)
        with self.assertRaises(ValueError): p.review_comment(dict(r, verdict='APPROVE'), 'a' * 40)

    def test_stale_base_guard(self):
        p.same_base('a' * 40, 'a' * 40)
        with self.assertRaises(ValueError): p.same_base('a' * 40, 'b' * 40)

    def test_actual_files_and_canonical_version_mapping(self):
        with tempfile.TemporaryDirectory() as d:
            root=pathlib.Path(d)
            (root/'.pilot').mkdir(); (root/'plugins/fleet/.claude-plugin').mkdir(parents=True); (root/'.claude-plugin').mkdir()
            (root/'.pilot/meta.json').write_text(json.dumps({'scope':'fleet','sha':'a'*40}))
            (root/'plugins/fleet/.claude-plugin/plugin.json').write_text(json.dumps({'name':'fleet','version':'1.0.0'}))
            (root/'.claude-plugin/marketplace.json').write_text(json.dumps({'plugins':[{'name':'fleet','source':'./plugins/fleet','version':'1.0.0'}]}))
            proposal={'summary':'fix', 'changes':[{'path':'plugins/fleet/.claude-plugin/plugin.json','content':json.dumps({'name':'fleet','version':'1.0.1'})},{'path':'plugins/fleet/main.ts','content':'export {};'}]}
            (root/'.pilot/report.json').write_text(json.dumps(proposal))
            previous=os.getcwd()
            try:
                os.chdir(root)
                with patch.object(p.subprocess,'check_output',return_value='a'*40+'\n'): p.apply_proposal()
                self.assertEqual((root/'plugins/fleet/main.ts').read_text(),'export {};')
                self.assertEqual(json.loads((root/'.claude-plugin/marketplace.json').read_text())['plugins'][0]['version'],'1.0.1')
            finally: os.chdir(previous)

    def test_no_comment_when_head_changed(self):
        meta={'mode':'review','number':1,'sha':'a'*40,'default':'main','actor':'writer','run_id':'7'}
        pr={'state':'open','head':{'sha':'b'*40,'repo':{'full_name':p.REPO}},'base':{'ref':'main','repo':{'full_name':p.REPO}}}
        responses={'':{'default_branch':'main'},'pulls/1':pr}
        env={'TARGET_NUMBER':'1','EXPECTED_SHA':'a'*40,'GITHUB_RUN_ID':'7','GITHUB_ACTOR':'writer','GITHUB_REF':'refs/heads/main'}
        with patch.dict(os.environ,env), patch.object(p,'check_writer'), patch.object(p,'repo_api',side_effect=lambda key:responses[key]):
            with self.assertRaisesRegex(ValueError,'head changed'): p.verify_meta(meta,'review')

    def test_workflow_permissions_and_secret_separation(self):
        # PyYAML is an inspection dependency only; workflows and policy use standard library.
        import yaml
        root=pathlib.Path(__file__).resolve().parents[1]
        for name, model_job in [('claude-review.yml','review'),('claude-implement.yml','propose')]:
            data=yaml.safe_load((root/'.github/workflows'/name).read_text())
            triggers=data.get('on',data.get(True))
            self.assertEqual(set(triggers),{'workflow_dispatch'})
            self.assertEqual(data['permissions'],{})
            self.assertIn('vars.CLAUDE_',data['jobs'][model_job]['if'])
            for job_name,job in data['jobs'].items():
                for step in job['steps']:
                    if 'uses' in step: self.assertRegex(step['uses'],r'@[0-9a-f]{40}$')
                    if job_name != model_job: self.assertNotIn('secrets.',json.dumps(step))
                    if step.get('uses','').startswith('anthropics/claude-code-action@'):
                        args=step['with']['claude_args']
                        self.assertIn("--tools ''",args); self.assertIn('--max-turns 1',args)
                        self.assertIn('--safe-mode',args); self.assertIn("--disallowedTools 'mcp__*'",args)
                        self.assertNotIn('anthropic_api_key',step['with'])
                        self.assertFalse(step['with']['show_full_output'])
            self.assertNotIn('write', data['jobs'][model_job]['permissions'].values())
            if model_job == 'propose':
                self.assertEqual(set(triggers['workflow_dispatch']['inputs']['plugin']['options']), p.SCOPES)
                self.assertEqual(data['jobs']['draft']['needs'], ['propose', 'test'])
                publish_env = data['jobs']['draft']['steps'][-1]['env']
                for name in ['meta', 'report']:
                    self.assertEqual(data['jobs']['propose']['outputs'][name+'_sha256'], '${{ steps.capture.outputs.'+name+'_sha256 }}')
                    self.assertEqual(publish_env['PRODUCER_'+name.upper()+'_SHA256'], '${{ needs.propose.outputs.'+name+'_sha256 }}')

    def test_issue_edit_refused_before_publish(self):
        meta={'mode':'implement','number':1,'sha':'a'*40,'default':'main','actor':'writer','run_id':'7','scope':'fleet','issue_updated_at':'old'}
        responses={'':{'default_branch':'main'},'git/ref/heads/main':{'object':{'sha':'a'*40}},'issues/1':{'state':'open','user':{'login':'writer'},'updated_at':'new'}}
        env={'TARGET_NUMBER':'1','EXPECTED_SHA':'a'*40,'GITHUB_RUN_ID':'7','GITHUB_ACTOR':'writer','GITHUB_REF':'refs/heads/main','PLUGIN_SCOPE':'fleet'}
        with patch.dict(os.environ,env), patch.object(p,'check_writer'), patch.object(p,'repo_api',side_effect=lambda key:responses[key]):
            with self.assertRaisesRegex(ValueError,'issue changed'): p.verify_meta(meta,'implement')

    def test_candidate_cannot_replace_tested_artifact(self):
        with tempfile.TemporaryDirectory() as d:
            root=pathlib.Path(d); (root/'.pilot').mkdir()
            (root/'.pilot/meta.json').write_text(json.dumps({'scope':'fleet','sha':'a'*40}))
            (root/'.pilot/report.json').write_text('{}')
            previous=os.getcwd()
            try:
                os.chdir(root)
                def tamper(*args,**kwargs): (root/'.pilot/report.json').write_text('{"changed":true}')
                with patch.object(p,'apply_proposal'),patch.object(p.subprocess,'run',side_effect=tamper),patch.object(p,'source_digest',return_value='d'*64,create=True):
                    with self.assertRaisesRegex(ValueError,'modified'): p.test_proposal()
                self.assertFalse((root/'.pilot/tested.json').exists())
            finally: os.chdir(previous)


class RegressionTests(unittest.TestCase):
    def producer_environment(self):
        return {'PRODUCER_'+name.upper()+'_SHA256':p.hashlib.sha256(pathlib.Path('.pilot/'+name+'.json').read_bytes()).hexdigest() for name in ['meta','report']}

    def test_documentation_issue_requires_and_applies_version_bump(self):
        with tempfile.TemporaryDirectory() as d:
            root=pathlib.Path(d);base=self.fixture(root);previous=os.getcwd()
            try:
                os.chdir(root)
                env={'GITHUB_REPOSITORY':p.REPO,'GITHUB_EVENT_NAME':'workflow_dispatch','GITHUB_REF':'refs/heads/main','GITHUB_ACTOR':'writer','TARGET_NUMBER':'1','EXPECTED_SHA':base,'GITHUB_RUN_ID':'7','PLUGIN_SCOPE':'fleet'}
                responses={'':{'default_branch':'main'},'git/ref/heads/main':{'object':{'sha':base}},'issues/1':{'state':'open','title':'Add usage documentation','body':'Document the existing command.','user':{'login':'writer'},'updated_at':'now'}}
                with patch.dict(os.environ,env),patch.object(p,'check_writer'),patch.object(p,'repo_api',side_effect=lambda key:responses[key]),patch.object(p,'output') as outputs:
                    p.prepare('implement')
                prompt=dict(call.args for call in outputs.call_args_list)['prompt']
                instruction=prompt.split('\nImmutable target: ',1)[0]
                self.assertIn('Bump the plugin manifest version for every plugin change, including documentation-only changes.',instruction)
                proposal={'summary':'document usage','changes':[{'path':'plugins/fleet/README.md','content':'# Existing command\n'},{'path':'plugins/fleet/.claude-plugin/plugin.json','content':json.dumps({'name':'fleet','version':'1.0.1'})}]}
                with patch.dict(os.environ,{'STRUCTURED_OUTPUT':json.dumps(proposal)}),patch.object(p,'output'):
                    p.capture('implement')
                p.apply_proposal()
                self.assertEqual(pathlib.Path('plugins/fleet/README.md').read_text(),'# Existing command\n')
                self.assertEqual(p.load('plugins/fleet/.claude-plugin/plugin.json')['version'],'1.0.1')
                self.assertEqual(p.load('.claude-plugin/marketplace.json')['plugins'][0]['version'],'1.0.1')
            finally: os.chdir(previous)

    def test_documentation_proposal_without_version_bump_refused(self):
        with tempfile.TemporaryDirectory() as d:
            root=pathlib.Path(d);self.fixture(root);previous=os.getcwd()
            try:
                os.chdir(root)
                p.dump('.pilot/report.json',{'summary':'document usage','changes':[{'path':'plugins/fleet/README.md','content':'# Existing command\n'}]})
                with self.assertRaisesRegex(ValueError,'plugin version must increase'): p.apply_proposal()
                self.assertEqual(p.load('.claude-plugin/marketplace.json')['plugins'][0]['version'],'1.0.0')
            finally: os.chdir(previous)

    def test_capture_authenticates_producer_before_candidate_execution(self):
        with tempfile.TemporaryDirectory() as d:
            root=pathlib.Path(d);self.fixture(root);previous=os.getcwd()
            try:
                os.chdir(root)
                proposal=pathlib.Path('.pilot/report.json').read_text()
                with patch.dict(os.environ,{'STRUCTURED_OUTPUT':proposal}),patch.object(p,'output') as outputs:
                    p.capture('implement')
                    self.assertEqual(dict(call.args for call in outputs.call_args_list), {name+'_sha256':digest for name,digest in [('meta',self.producer_environment()['PRODUCER_META_SHA256']),('report',self.producer_environment()['PRODUCER_REPORT_SHA256'])]})
            finally: os.chdir(previous)

    def prepare_review(self, comparison=None):
        head, base = 'a'*40, 'c'*40
        pr={'state':'open','changed_files':1,'head':{'sha':head,'repo':{'full_name':p.REPO}},'base':{'sha':base,'ref':'main','repo':{'full_name':p.REPO}}}
        good={'filename':'plugins/fleet/right.md','patch':'@@ -0,0 +1 @@\n+HEAD A ONLY','additions':1,'deletions':0}
        comparison=comparison or {'base_commit':{'sha':base},'merge_base_commit':{'sha':base},'commits':[{'sha':head}],'status':'ahead','files':[good]}
        requests=[]
        def api(key):
            requests.append(key)
            if key=='': return {'default_branch':'main'}
            if key=='git/ref/heads/main': return {'object':{'sha':base}}
            if key=='pulls/1': return pr
            if key=='pulls/1/files?per_page=100': return [dict(good,patch='@@ -0,0 +1 @@\n+HEAD B ONLY')]
            if key==f'compare/{base}...{head}': return comparison
            raise AssertionError(key)
        with tempfile.TemporaryDirectory() as d:
            previous=os.getcwd()
            try:
                os.chdir(d)
                env={'GITHUB_REPOSITORY':p.REPO,'GITHUB_EVENT_NAME':'workflow_dispatch','GITHUB_REF':'refs/heads/main','GITHUB_ACTOR':'writer','TARGET_NUMBER':'1','EXPECTED_SHA':head,'GITHUB_RUN_ID':'7','GITHUB_OUTPUT':str(pathlib.Path(d)/'output.txt')}
                with patch.dict(os.environ,env),patch.object(p,'check_writer'),patch.object(p,'repo_api',side_effect=api): p.prepare('review')
                return pathlib.Path('output.txt').read_text(),p.load('.pilot/meta.json'),requests
            finally: os.chdir(previous)

    def test_review_a_b_a_race_cannot_use_mutable_pr_diff(self):
        prompt,meta,requests=self.prepare_review()
        self.assertIn('HEAD A ONLY',prompt)
        self.assertNotIn('HEAD B ONLY',prompt)
        self.assertNotIn('pulls/1/files?per_page=100',requests)
        self.assertEqual(meta['diff_base_sha'],'c'*40)

    def test_compare_mismatch_or_missing_patch_refused(self):
        for field,value in [('base_commit',{'sha':'b'*40}),('commits',[{'sha':'b'*40}]),('files',[{'filename':'x','additions':1,'deletions':0}])]:
            comparison={'base_commit':{'sha':'c'*40},'merge_base_commit':{'sha':'c'*40},'commits':[{'sha':'a'*40}],'status':'ahead','files':[{'filename':'x','patch':'+A','additions':1,'deletions':0}]}
            comparison[field]=value
            with self.subTest(field=field),self.assertRaises(ValueError): self.prepare_review(comparison)

    def fixture(self, root):
        import subprocess
        (root/'.pilot').mkdir();(root/'plugins/fleet/.claude-plugin').mkdir(parents=True);(root/'.claude-plugin').mkdir()
        (root/'plugins/fleet/.claude-plugin/plugin.json').write_text(json.dumps({'name':'fleet','version':'1.0.0'}))
        (root/'.claude-plugin/marketplace.json').write_text(json.dumps({'plugins':[{'name':'fleet','source':'./plugins/fleet','version':'1.0.0'}]}))
        (root/'outside.ts').write_text('trusted baseline')
        subprocess.run(['git','init','-q'],cwd=root,check=True,capture_output=True)
        subprocess.run(['git','add','.'],cwd=root,check=True,capture_output=True)
        subprocess.run(['git','-c','user.name=Offline Test','-c','user.email=offline@example.invalid','commit','-qm','fixture'],cwd=root,check=True,capture_output=True)
        base=subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()
        p.dump(root/'.pilot/meta.json',{'scope':'fleet','sha':base,'number':1,'default':'main','run_id':'7'})
        p.dump(root/'.pilot/report.json',{'summary':'fix','changes':[{'path':'plugins/fleet/.claude-plugin/plugin.json','content':json.dumps({'name':'fleet','version':'1.0.1'})},{'path':'plugins/fleet/main.ts','content':'export const tested = true;\n'}]})
        return base

    def test_tests_cannot_attest_a_mutated_or_extra_source_tree(self):
        for target in ['plugins/fleet/main.ts','outside.ts','plugins/fleet/extra.ts']:
            with self.subTest(target=target),tempfile.TemporaryDirectory() as d:
                root=pathlib.Path(d);self.fixture(root);previous=os.getcwd()
                try:
                    os.chdir(root)
                    real_run=p.subprocess.run
                    def tamper(args,**kwargs):
                        if args[0]=='claude': pathlib.Path(target).write_text('different tested source')
                        else: return real_run(args,**kwargs)
                    with patch.object(p.subprocess,'run',side_effect=tamper):
                        with self.assertRaisesRegex(ValueError,'source'): p.test_proposal()
                    self.assertFalse(pathlib.Path('.pilot/tested.json').exists())
                finally: os.chdir(previous)

    def test_publish_rechecks_actual_tree_before_any_api_write(self):
        with tempfile.TemporaryDirectory() as d:
            root=pathlib.Path(d);self.fixture(root);previous=os.getcwd()
            try:
                os.chdir(root)
                real_run=p.subprocess.run
                with patch.object(p.subprocess,'run',side_effect=lambda args,**kwargs: None if args[0]=='claude' else real_run(args,**kwargs)): p.test_proposal()
                self.assertRegex(p.load('.pilot/tested.json')['source_sha256'],r'^[0-9a-f]{64}$')
                pathlib.Path('plugins/fleet/.claude-plugin/plugin.json').write_text(json.dumps({'name':'fleet','version':'1.0.0'}))
                pathlib.Path('outside.ts').write_text('publish tree differs')
                with patch.dict(os.environ,self.producer_environment()),patch.object(p,'verify_meta'),patch.object(p,'repo_api') as writes:
                    with self.assertRaisesRegex(ValueError,'source'): p.publish()
                    writes.assert_not_called()
            finally: os.chdir(previous)

    def test_legacy_receipt_cannot_claim_tested_source(self):
        with tempfile.TemporaryDirectory() as d:
            root=pathlib.Path(d);base=self.fixture(root);previous=os.getcwd()
            try:
                os.chdir(root)
                p.dump('.pilot/tested.json',{'base':base,'report_sha256':p.hashlib.sha256(pathlib.Path('.pilot/report.json').read_bytes()).hexdigest(),'tests':'old unbound receipt'})
                with patch.dict(os.environ,self.producer_environment()),patch.object(p,'verify_meta'),patch.object(p,'repo_api') as writes:
                    with self.assertRaisesRegex(ValueError,'source'): p.publish()
                    writes.assert_not_called()
            finally: os.chdir(previous)


    def test_same_tested_source_can_publish_and_records_digest(self):
        with tempfile.TemporaryDirectory() as d:
            root=pathlib.Path(d);self.fixture(root);previous=os.getcwd()
            try:
                os.chdir(root)
                real_run=p.subprocess.run
                with patch.object(p.subprocess,'run',side_effect=lambda args,**kwargs: None if args[0]=='claude' else real_run(args,**kwargs)): p.test_proposal()
                attestation=p.load('.pilot/tested.json')['source_sha256']
                pathlib.Path('plugins/fleet/.claude-plugin/plugin.json').write_text(json.dumps({'name':'fleet','version':'1.0.0'}))
                calls=[]
                def api(path,data=None):
                    calls.append((path,data))
                    if path.startswith('git/commits/'): return {'tree':{'sha':'b'*40}}
                    if path=='pulls': return {'html_url':'https://example.invalid/draft'}
                    return {'sha':'c'*40}
                with patch.dict(os.environ,self.producer_environment()),patch.object(p,'verify_meta'),patch.object(p,'repo_api',side_effect=api): p.publish()
                draft=next(data for path,data in calls if path=='pulls')
                self.assertTrue(draft['draft']);self.assertIn(attestation,draft['body'])
                content=[data['content'] for path,data in calls if path=='git/blobs']
                self.assertIn('export const tested = true;\n',content)
            finally: os.chdir(previous)

    def test_background_replacement_of_report_and_matching_receipt_refused(self):
        for artifact in ['report','meta']:
            with self.subTest(artifact=artifact),tempfile.TemporaryDirectory() as d:
                root=pathlib.Path(d);self.fixture(root);previous=os.getcwd()
                try:
                    os.chdir(root)
                    trusted=self.producer_environment()
                    real_run=p.subprocess.run
                    with patch.object(p.subprocess,'run',side_effect=lambda args,**kwargs: None if args[0]=='claude' else real_run(args,**kwargs)): p.test_proposal()
                    data=p.load('.pilot/'+artifact+'.json')
                    if artifact=='report': data['changes'][1]['content']='export const neverTested = true;\n'
                    else: data['scope']='session-inbox'
                    p.dump('.pilot/'+artifact+'.json',data)
                    receipt=p.load('.pilot/tested.json')
                    receipt['report_sha256']=p.hashlib.sha256(pathlib.Path('.pilot/report.json').read_bytes()).hexdigest()
                    receipt['source_sha256']='f'*64
                    p.dump('.pilot/tested.json',receipt)
                    with patch.dict(os.environ,trusted),patch.object(p,'verify_meta') as verify,patch.object(p,'repo_api') as writes:
                        with self.assertRaisesRegex(ValueError,'trusted producer'): p.publish()
                        verify.assert_not_called();writes.assert_not_called()
                finally: os.chdir(previous)

    def test_missing_producer_attestation_refused(self):
        with tempfile.TemporaryDirectory() as d:
            root=pathlib.Path(d);self.fixture(root);previous=os.getcwd()
            try:
                os.chdir(root)
                with patch.dict(os.environ,{'PRODUCER_META_SHA256':'','PRODUCER_REPORT_SHA256':''}),patch.object(p,'repo_api') as writes:
                    with self.assertRaisesRegex(ValueError,'trusted producer'): p.publish()
                    writes.assert_not_called()
            finally: os.chdir(previous)

    def test_review_base_changed_even_with_same_head_refused(self):
        meta={'mode':'review','number':1,'sha':'a'*40,'default':'main','actor':'writer','run_id':'7','diff_base_sha':'c'*40}
        pr={'state':'open','head':{'sha':'a'*40,'repo':{'full_name':p.REPO}},'base':{'sha':'d'*40,'ref':'main','repo':{'full_name':p.REPO}}}
        responses={'':{'default_branch':'main'},'pulls/1':pr}
        env={'TARGET_NUMBER':'1','EXPECTED_SHA':'a'*40,'GITHUB_RUN_ID':'7','GITHUB_ACTOR':'writer','GITHUB_REF':'refs/heads/main'}
        with patch.dict(os.environ,env),patch.object(p,'check_writer'),patch.object(p,'repo_api',side_effect=lambda key:responses[key]):
            with self.assertRaisesRegex(ValueError,'base changed'): p.verify_meta(meta,'review')

if __name__ == '__main__': unittest.main()
