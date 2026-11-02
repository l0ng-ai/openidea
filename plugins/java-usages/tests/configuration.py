"""Real JDT LS configuration-navigation regression and warm-query benchmark.
Run with Java 25 on PATH: python3 configuration.py /path/to/jdtls
Fixtures use small Spring API stubs; no Maven/network/build of a user's project.
"""
import os
import json
import pathlib
import platform
import queue
import subprocess
import sys
import tempfile
import threading
import time
import zipfile

home = pathlib.Path(sys.argv[1]).resolve()
bundle = pathlib.Path(__file__).resolve().parents[1] / 'openidea-java-usages.jar'
work = pathlib.Path(tempfile.mkdtemp(prefix='openidea-configuration-'))
project = work / 'project'
source_dir = project / 'src'
source_dir.mkdir(parents=True)

def write(relative, text):
    file = source_dir / relative
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(text)
    return file

write('org/springframework/boot/context/properties/ConfigurationProperties.java', '''package org.springframework.boot.context.properties;
public @interface ConfigurationProperties { String value() default ""; String prefix() default ""; }''')
write('org/springframework/boot/context/properties/bind/Name.java', 'package org.springframework.boot.context.properties.bind; public @interface Name { String value(); }')
write('org/springframework/beans/factory/annotation/Value.java', '''package org.springframework.beans.factory.annotation;
public @interface Value { String value(); }''')
write('org/springframework/core/env/PropertyResolver.java', '''package org.springframework.core.env;
public interface PropertyResolver { String getProperty(String key); String getRequiredProperty(String key); }''')
write('org/springframework/core/env/Environment.java', '''package org.springframework.core.env;
public interface Environment extends PropertyResolver {}''')
source = '''package demo;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.env.Environment;
@ConfigurationProperties(prefix="app")
class Settings extends Parent {
    int timeOut;
    Nested nested;
    java.util.List<Nested> clients;
    java.util.Map<String, Nested> routes;
    java.util.List<String> tags;
    java.util.Map<String, String> labels;
    public int getTimeOut() { return timeOut; }
    public void setTimeOut(int value) { timeOut = value; }
}
class Parent { boolean enabled; }
class Nested { String url; }
@ConfigurationProperties("record")
record RecordSettings(String name, int count) {}
@ConfigurationProperties("constructor")
class ConstructorSettings {
    ConstructorSettings(@org.springframework.boot.context.properties.bind.Name("remote-name") String name) {}
}
class Consumers {
    static final String KEY = "app.time-out";
    @Value("${app.time-out:30}") String timeout;
    @Value("${app.missing:${app.backup:42}}") String fallback;
    String call(Environment env) { return env.getProperty(KEY); }
    String required(Environment env) { return env.getRequiredProperty("app.required"); }
    String dynamic(Environment env, String key) { return env.getProperty(key); }
    String unrelated(Fake env) { return env.getProperty("app.time-out"); }
    @ConfigurationProperties("bean") Nested bean() { return new Nested(); }
}
class Fake { String getProperty(String name) { return name; } }
'''
file = write('demo/Settings.java', source)
if os.environ.get('OPENIDEA_CONFIGURATION_STRESS') == '1':
    for i in range(3000):
        write(f'noise/Plain{i}.java', f'package noise; class Plain{i} {{ int number; }}')
    for i in range(100):
        write(f'noise/Config{i}.java', f'package noise; @org.springframework.boot.context.properties.ConfigurationProperties(prefix="stress{i}") class Config{i} {{ int value; }}')
write('demo/NotSpring.java', '''package demo;
@interface ConfigurationProperties { String prefix(); }
@ConfigurationProperties(prefix="fake") class NotSpring { int timeOut; }
''')
local_metadata = project / 'src/main/resources/META-INF'
local_metadata.mkdir(parents=True)
(local_metadata / 'additional-spring-configuration-metadata.json').write_text(json.dumps({
    'groups': [{'name': 'extra', 'sourceType': 'demo.Nested', 'type': 'demo.Nested'}],
    'properties': [{'name': 'extra.url', 'sourceType': 'demo.Nested'}]
}))
# A dependency with metadata and attached source exercises actual library locations.
libsource = work / 'libsrc/vendor/LibrarySettings.java'
libsource.parent.mkdir(parents=True)
libsource.write_text('package vendor; public class LibrarySettings { public int port; public int getPort() { return port; } }')
classes = work / 'libclasses'
classes.mkdir()
subprocess.run(['javac', '--release', '21', '-d', str(classes), str(libsource)], check=True)
library = work / 'library.jar'
metadata = {'groups': [{'name': 'vendor', 'type': 'vendor.LibrarySettings', 'sourceType': 'vendor.LibrarySettings'}],
            'properties': [{'name': 'vendor.port', 'type': 'java.lang.Integer', 'sourceType': 'vendor.LibrarySettings'}]}
with zipfile.ZipFile(library, 'w') as z:
    z.write(classes / 'vendor/LibrarySettings.class', 'vendor/LibrarySettings.class')
    z.writestr('META-INF/spring-configuration-metadata.json', json.dumps(metadata))
sourcejar = work / 'library-sources.jar'
with zipfile.ZipFile(sourcejar, 'w') as z:
    z.write(libsource, 'vendor/LibrarySettings.java')
(project / '.project').write_text('<projectDescription><name>configuration</name><buildSpec><buildCommand><name>org.eclipse.jdt.core.javabuilder</name></buildCommand></buildSpec><natures><nature>org.eclipse.jdt.core.javanature</nature></natures></projectDescription>')
spring_jar = os.environ.get('OPENIDEA_SPRING_BOOT_JAR')
extra_classpath = f'<classpathentry kind="lib" path="{pathlib.Path(spring_jar).resolve()}"/>' if spring_jar else ''
(project / '.classpath').write_text(f'<classpath><classpathentry kind="src" path="src"/><classpathentry kind="con" path="org.eclipse.jdt.launching.JRE_CONTAINER"/><classpathentry kind="lib" path="{library}" sourcepath="{sourcejar}"/>{extra_classpath}<classpathentry kind="output" path="bin"/></classpath>')
config = work / 'config'
config.mkdir()
name = {'Darwin': 'config_mac', 'Windows': 'config_win'}.get(platform.system(), 'config_linux')
names = ([name + '_arm'] if platform.machine().lower() in ('arm64', 'aarch64') else []) + [name]
(config / 'config.ini').write_bytes(next(home / n / 'config.ini' for n in names if (home / n / 'config.ini').exists()).read_bytes())
log = (work / 'stderr.log').open('w')
proc = subprocess.Popen(['java', '-Declipse.application=org.eclipse.jdt.ls.core.id1', '-Dosgi.bundles.defaultStartLevel=4', '-Declipse.product=org.eclipse.jdt.ls.core.product', '-Xmx1G', '--add-modules=ALL-SYSTEM', '--add-opens', 'java.base/java.util=ALL-UNNAMED', '--add-opens', 'java.base/java.lang=ALL-UNNAMED', '-jar', str(next((home / 'plugins').glob('org.eclipse.equinox.launcher_*.jar'))), '-configuration', str(config), '-data', str(work / 'metadata')], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log)
messages = queue.Queue()
lock = threading.Lock()
def send(message):
    data = json.dumps(message).encode()
    with lock:
        proc.stdin.write(f'Content-Length: {len(data)}\r\n\r\n'.encode() + data)
        proc.stdin.flush()
def read():
    while True:
        headers = {}
        while True:
            line = proc.stdout.readline()
            if not line: return
            if line == b'\r\n': break
            k, v = line.decode().split(':', 1)
            headers[k.lower()] = v.strip()
        message = json.loads(proc.stdout.read(int(headers['content-length'])))
        if 'method' in message and 'id' in message:
            send({'jsonrpc': '2.0', 'id': message['id'], 'result': [] if message['method'] == 'workspace/configuration' else None})
        else: messages.put(message)
threading.Thread(target=read, daemon=True).start()
sequence = 0
transcript = []
def request(method, params):
    global sequence
    sequence += 1
    send({'jsonrpc': '2.0', 'id': sequence, 'method': method, 'params': params})
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        msg = messages.get(timeout=max(1, deadline - time.monotonic()))
        transcript.append(msg)
        if msg.get('id') == sequence:
            if 'error' in msg: raise RuntimeError(msg['error'])
            return msg.get('result')
    raise TimeoutError(method)
def query(key, uri=None, line=0, col=0):
    return request('workspace/executeCommand', {'command': 'openidea.java.configuration', 'arguments': [uri or (project / 'application.yml').as_uri(), key, line, col, key is None, False]})
def names(result):
    return {p['name'] for p in result['keys']}
try:
    init = request('initialize', {'processId': None, 'rootUri': project.as_uri(), 'workspaceFolders': [{'uri': project.as_uri(), 'name': 'configuration'}], 'capabilities': {'textDocument': {'definition': {'linkSupport': False}}}, 'initializationOptions': {'bundles': [str(bundle)], 'extendedClientCapabilities': {'classFileContentsSupport': True}, 'settings': {'java': {'import': {'gradle': {'enabled': False}, 'maven': {'enabled': False}}}}}})
    send({'jsonrpc': '2.0', 'method': 'initialized', 'params': {}})
    send({'jsonrpc': '2.0', 'method': 'textDocument/didOpen', 'params': {'textDocument': {'uri': file.as_uri(), 'languageId': 'java', 'version': 1, 'text': source}}})
    request('java/buildWorkspace', True)
    assert 'openidea.java.configuration' in init['capabilities']['executeCommandProvider']['commands'], init
    results = {}
    for key in ['app', 'vendor', 'app.time-out', 'app.enabled', 'app.nested.url', 'app.clients[0].url', 'app.routes.east.url', 'app.tags[0]', 'app.labels.region', 'app.labels[region.name]', 'constructor.remote-name', 'record.name', 'bean.url', 'app.backup', 'app.required', 'vendor.port', 'extra.url']:
        start = time.perf_counter()
        result = query(key)
        results[key] = {'seconds': time.perf_counter() - start, 'response': result}
        assert result['locations'], (key, result)
    attached = request('java/classFileContents', {'uri': results['vendor.port']['response']['locations'][0]['uri']})
    assert attached and 'LibrarySettings' in attached and 'port' in attached, attached
    if spring_jar:
        for key in ['server.port', 'spring.datasource.url', 'spring.jackson.date-format']:
            result = query(key)
            assert result['locations'], (key, result)
            assert all(loc['uri'].startswith('jdt://') for loc in result['locations']), result
            results[key] = {'response': result}
            if key == 'server.port':
                decompiled = request('java/classFileContents', {'uri': result['locations'][0]['uri']})
                assert decompiled and 'ServerProperties' in decompiled and 'port' in decompiled, decompiled
    assert not query('app.tags[0].value')['locations']
    assert not query('app.labels.region.coder')['locations']
    assert not query('fake.time-out')['locations']
    assert not query('app.does-not-exist')['locations']
    metadata_file = local_metadata / 'additional-spring-configuration-metadata.json'
    metadata_file.write_text(metadata_file.read_text().replace('extra', 'newer'))
    assert query('newer.url')['locations']
    assert not query('extra.url')['locations']
    # Property references include member usages and consumers, without declarations.
    references = request('workspace/executeCommand', {'command': 'openidea.java.configuration',
        'arguments': [(project / 'application.yml').as_uri(), 'app.time-out', 0, 0, True, False]})
    assert references['locations'], references
    assert any(loc['range']['start']['line'] == next(i for i, line in enumerate(source.splitlines()) if 'getProperty(KEY)' in line) for loc in references['locations']), references
    # 3 binding targets + @Value + Environment constant; Fake.getProperty excluded.
    timeout = query('app.time-out')
    assert len(timeout['locations']) == 5, timeout
    for needle, expected in [('int timeOut;', 'app.timeOut'), ('"${app.time-out:30}"', 'app.time-out'), ('env.getProperty(KEY)', 'app.time-out')]:
        line, text = next((i, s) for i, s in enumerate(source.splitlines()) if needle in s)
        col = text.index(needle) + (4 if needle == 'int timeOut;' else (len('env.getProperty(') if needle.startswith('env.') else 4))
        reverse = query(None, file.as_uri(), line, col)
        assert expected in names(reverse), (needle, reverse)
    warm = []
    for _ in range(20):
        start = time.perf_counter(); query('app.time-out'); warm.append(time.perf_counter() - start)
    # Unsaved changes must replace old keys, and closing must restore disk keys.
    changed = source.replace('prefix="app"', 'prefix="edited"').replace('${app.time-out:30}', '${edited.timeout:30}')
    send({'jsonrpc': '2.0', 'method': 'textDocument/didChange', 'params': {'textDocument': {'uri': file.as_uri(), 'version': 2}, 'contentChanges': [{'text': changed}]}})
    edit_start = time.perf_counter()
    updated = query('edited.time-out')
    edit_ms = (time.perf_counter() - edit_start) * 1000
    assert updated['locations'], updated
    assert not query('app.nested.url')['locations']
    send({'jsonrpc': '2.0', 'method': 'textDocument/didClose', 'params': {'textDocument': {'uri': file.as_uri()}}})
    restored = query('app.nested.url')
    assert restored['locations'], restored
    evidence = {'stress': os.environ.get('OPENIDEA_CONFIGURATION_STRESS') == '1', 'editRebuildMs': edit_ms, 'cases': results, 'warmMedianMs': sorted(warm)[len(warm)//2] * 1000, 'warmMaxMs': max(warm) * 1000}
    (work / 'evidence.json').write_text(json.dumps(evidence, indent=2))
    print(json.dumps(evidence, indent=2))
finally:
    (work / 'transcript.json').write_text(json.dumps(transcript, indent=2))
    proc.terminate(); proc.wait(timeout=20)
    print('Evidence:', work, file=sys.stderr)
