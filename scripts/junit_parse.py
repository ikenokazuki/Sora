import sys, xml.etree.ElementTree as ET
t = ET.parse(sys.argv[1])
bad = []
for tc in t.getroot().iter('testcase'):
    if tc.find('failure') is not None or tc.find('error') is not None:
        bad.append((tc.get('classname', ''), tc.get('name', '')))
print('## Failing tests: %d' % len(bad))
for cls, name in bad[:30]:
    print('- %s > %s' % (cls, name))
