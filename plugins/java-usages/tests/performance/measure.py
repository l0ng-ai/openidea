"""Sequential, alternating-order fresh JVM trials; do not run builds concurrently."""
import pathlib
import subprocess
import sys
home, lombok, root = map(lambda p:pathlib.Path(p).resolve(),sys.argv[1:4])
runner=pathlib.Path(__file__).parent/'run.py'
for variant in ['baseline','optimized','fallback']:
    subprocess.run(['python3',str(runner),str(home),str(lombok),str(root/f'{variant}-count/openidea-java-usages.jar'),str(root/f'count-{variant}.json'),str(root/'instrument/counter.jar')],check=True)
for i in range(3):
    for variant in (['baseline','optimized'] if i%2==0 else ['optimized','baseline']):
        subprocess.run(['python3',str(runner),str(home),str(lombok),str(root/variant/'openidea-java-usages.jar'),str(root/f'{variant}-{i}.json')],check=True)
