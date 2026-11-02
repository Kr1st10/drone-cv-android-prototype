"""Leakage-conservative grouped split with immutable frozen test lock."""
import hashlib
import json
from .duplicates import duplicate_pairs
from .core import validate_record

SPLITS=('train','validation','test')

class UnionFind:
    def __init__(self,items): self.parent={x:x for x in items}
    def find(self,x):
        while self.parent[x]!=x:
            self.parent[x]=self.parent[self.parent[x]];x=self.parent[x]
        return x
    def union(self,a,b):
        a,b=self.find(a),self.find(b)
        if a!=b:self.parent[max(a,b)]=min(a,b)


def signature(r):
    """Lock all annotation, rights, provenance, identity and pixel metadata."""
    return hashlib.sha256(json.dumps(r,sort_keys=True,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()


def make_split(records, seed='stage45-v1', previous=None, freeze=False):
    if not records: raise ValueError('empty dataset')
    ids=[r.get('id') for r in records]
    if len(set(ids))!=len(ids): raise ValueError('duplicate record IDs')
    for r in records:
        errors,_=validate_record(r)
        if errors: raise ValueError(f"invalid {r.get('id')}: {'; '.join(errors)}")
        if r['review_status']!='reviewed' or r['independence']!='verified' or r['usage_history']!='unused' or not r['source_group_verified']:
            raise ValueError('all split records require reviewed annotations, verified provenance/independence and unused history; quarantine the rest')
    uf=UnionFind(ids); lookup={}
    # Namespaced keys avoid accidental collision between group types. Equivalence
    # is transitive across video IDs, source groups, exact and possible duplicates.
    for r in records:
        for key in [('sequence',r['sequence_id']),('source_group',r['source_group'])] + ([('video',r['video_sha256'])] if r.get('video_sha256') else []):
            if key in lookup:uf.union(r['id'],lookup[key])
            else:lookup[key]=r['id']
    pairs=duplicate_pairs(records)
    for p in pairs:uf.union(p['a'],p['b'])
    groups={}
    for r in records: groups.setdefault(uf.find(r['id']),[]).append(r)
    if previous and previous.get('version')!=1: raise ValueError('invalid lock version')
    old=(previous or {}).get('records',{}); frozen=bool((previous or {}).get('test_frozen',False))
    if previous and previous.get('seed')!=seed: raise ValueError('lock seed mismatch')
    if set(old)-set(ids): raise ValueError('locked record removed')
    for r in records:
        if r['id'] in old and old[r['id']]['signature']!=signature(r):raise ValueError('locked record changed')
    assignments={}
    for group in groups.values():
        prior={old[r['id']]['split'] for r in group if r['id'] in old}
        if not prior.issubset(set(SPLITS)):raise ValueError('invalid locked split')
        if len(prior)>1:raise ValueError('new evidence links previously locked different splits')
        if frozen and prior=={'test'} and any(r['id'] not in old for r in group):raise ValueError('new record links to frozen test; quarantine it')
        if prior: chosen=next(iter(prior))
        else:
            key=min(r['id'] for r in group)
            n=int.from_bytes(hashlib.sha256((seed+':'+key).encode()).digest()[:8],'big')/(1<<64)
            # 70/15/15 initially. After test freeze, NEW groups are 70:15 train:val only.
            chosen=('train' if n<.7 else 'validation' if n<.85 else 'test') if not frozen else ('train' if n<.7/.85 else 'validation')
        for r in group:assignments[r['id']]=chosen
    if freeze and set(assignments.values())!=set(SPLITS):raise ValueError('cannot freeze: train, validation and test must all be nonempty')
    lock={'version':1,'seed':seed,'test_frozen':bool(frozen or freeze),
          'records':{r['id']:{'split':assignments[r['id']],'signature':signature(r)} for r in records}}
    return assignments,lock,pairs
