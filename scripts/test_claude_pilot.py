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
                with patch.object(p,'apply_proposal'),patch.object(p.subprocess,'run',side_effect=tamper):
                    with self.assertRaisesRegex(ValueError,'modified'): p.test_proposal()
                self.assertFalse((root/'.pilot/tested.json').exists())
            finally: os.chdir(previous)

if __name__ == '__main__': unittest.main()
