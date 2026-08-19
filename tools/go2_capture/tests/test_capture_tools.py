import pathlib,subprocess,sys
ROOT=pathlib.Path(__file__).parents[3]; CAP=ROOT/'tools/go2_capture'
def test_fail_closed_sources():
 text='\n'.join(p.read_text() for p in CAP.rglob('*') if p.is_file() and p.suffix in ('.sh','.py') and p.name!='test_capture_tools.py')
 assert 'create_publisher' not in text
 assert 'LowCmd' not in text
 assert 'MotorCmd' not in text
 assert 'SportClient' not in text
 assert 'publish' not in text.lower() or 'ros2 bag record' in text
def test_marker_and_fixture(tmp_path):
 d=tmp_path/'trial'; subprocess.run([sys.executable,str(CAP/'tests'/'fake_fixture.py'),'--trial-dir',str(d),'--seconds','1'],check=True)
 subprocess.run([sys.executable,str(CAP/'mark_event.py'),'TRIAL_START','--trial-dir',str(d)],check=True)
 assert (d/'events.csv').read_text().count('TRIAL_START')==1
 assert len((d/'bag'/'lowstate.jsonl').read_text().splitlines())>10
