// Temporary proof on an isolated GitHub-hosted Ubuntu VM, never part of the product's PR.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installScript } from './cloud/src/install.ts';

assert.equal(process.platform, 'linux');
const evidence = resolve('verification-evidence');
mkdirSync(evidence, {recursive:true});
const version = execFileSync('/usr/bin/systemd-analyze', ['--version'], {encoding:'utf8'});
console.log(version);
writeFileSync(join(evidence,'systemd-version.txt'),version);
const baselineFile = resolve('cloud/src/_verify-install-baseline.ts');
writeFileSync(baselineFile,execFileSync('git',['show','ec2fa0e09:cloud/src/install.ts']));
const baseline = await import(pathToFileURL(baselineFile));
const results = [];
function verify(label, script, dataName, shouldWork) {
  const root = mkdtempSync(join(tmpdir(),'stillfail-paths-'));
  const home = join(root,'home'), stub = join(root,'stub'), release = join(root,'release/stillfail');
  const data = join(root,dataName), extra = join(root,String.raw`tools "quoted" 'single'\bin %h $HOME`);
  const unitName = `stillfail-paths-${label}.service`;
  const installedUnit = `/run/systemd/system/${unitName}`;
  let installed = false;
  const calls = [];
  const call = (command,args) => {
    const r = spawnSync(command,args,{encoding:'utf8'});
    calls.push({command,args,status:r.status,stdout:r.stdout,stderr:r.stderr});
    return r;
  };
  try {
    for(const dir of [home,stub,join(release,'bin')]) mkdirSync(dir,{recursive:true});
    writeFileSync(join(release,'bin/stillfail'),'#!/bin/sh\nexit 0\n',{mode:0o755});
    writeFileSync(join(release,'VERSION'),'proof\n');
    execFileSync('tar',['-czf',join(root,'release.tar.gz'),'-C',join(root,'release'),'stillfail']);
    for(const name of ['systemctl','loginctl']) writeFileSync(join(stub,name),'#!/bin/sh\nexit 0\n',{mode:0o755});
    writeFileSync(join(stub,'curl'),`#!/bin/sh\nwhile [ $# -gt 0 ]; do [ "$1" = -o ] && cp '${join(root,'release.tar.gz')}' "$2"; shift; done\n`,{mode:0o755});
    const installedResult=spawnSync('/bin/sh',['-c',script,'sh','fake-token'],{
      env:{HOME:home,PATH:`${stub}:${extra}:/usr/bin:/bin:/usr/sbin:/sbin`,STILLFAIL_DATA:data},
      encoding:'utf8',
    });
    writeFileSync(join(evidence,`${label}-installer.txt`),installedResult.stdout+installedResult.stderr);
    assert.equal(installedResult.status,0,installedResult.stdout+installedResult.stderr);
    const unitFile=join(home,'.config/systemd/user/stillfail-station.service');
    const unit=readFileSync(unitFile,'utf8')+`\n[Service]\nType=oneshot\nRestart=no\nEnvironment="HOME=${home}"\n`;
    writeFileSync(unitFile,unit);
    writeFileSync(join(evidence,`${label}.service`),unit);
    writeFileSync(join(data,'app/bin/stillfail'),'#!/bin/sh\nprintf \'%s\\0\' "$STILLFAIL_DATA" "$PATH" "$1" > "$HOME/actual"\nprintf "stdout\\n"\nprintf "stderr\\n" >&2\n',{mode:0o755});
    const parsed=call('/usr/bin/systemd-analyze',['verify','--man=no',unitFile]);
    if(!shouldWork) {
      assert.notEqual(parsed.status,0,'the baseline must fail actual systemd validation');
      results.push({label,expected:'invalid baseline',actual:parsed.status});
      return;
    }
    assert.equal(parsed.status,0,parsed.stdout+parsed.stderr);
    assert.doesNotMatch(parsed.stderr,/Invalid environment|Failed to resolve|Failed to parse|Ignoring/i);
    const copy=call('sudo',['-n','cp',unitFile,installedUnit]);
    assert.equal(copy.status,0,copy.stderr); installed=true;
    assert.equal(call('sudo',['-n','systemctl','daemon-reload']).status,0);
    const started=call('sudo',['-n','systemctl','start',unitName]);
    assert.equal(started.status,0,started.stderr);
    const actual=readFileSync(join(home,'actual'),'utf8').split('\0');
    assert.equal(actual[0],data);
    assert.ok(actual[1].split(':').includes(extra),actual[1]);
    assert.equal(actual[2],'start');
    const logged=readFileSync(join(data,'stillfail.log'),'utf8');
    assert.match(logged,/stdout/); assert.match(logged,/stderr/);
    const properties=call('sudo',['-n','systemctl','show',unitName,'-p','ExecStart','-p','Environment','-p','StandardOutput','-p','StandardError']);
    assert.equal(properties.status,0,properties.stderr);
    writeFileSync(join(evidence,`${label}-actual.json`),JSON.stringify({data:actual[0],path:actual[1],argument:actual[2],logged,properties:properties.stdout},null,2));
    results.push({label,expected:'exact paths preserved',actual:'parsed and executed; environment and both logs match'});
  } finally {
    if(installed) {
      call('sudo',['-n','systemctl','stop',unitName]);
      call('sudo',['-n','rm','-f',installedUnit]);
      call('sudo',['-n','systemctl','daemon-reload']);
    }
    writeFileSync(join(evidence,`${label}-commands.json`),JSON.stringify(calls,null,2));
    rmSync(root,{recursive:true,force:true});
  }
}
try {
  verify('before',baseline.installScript('https://installer.invalid'),'station data %u $HOME',false);
  verify('ordinary',installScript('https://installer.invalid'),'station',true);
  verify('spaces',installScript('https://installer.invalid'),'station data %u $HOME',true);
  verify('quoted',installScript('https://installer.invalid'),String.raw`station "double" 'single'\path %u $HOME`,true);
} finally {
  rmSync(baselineFile,{force:true});
  writeFileSync(join(evidence,'results.json'),JSON.stringify(results,null,2));
  console.log(JSON.stringify(results,null,2));
}
