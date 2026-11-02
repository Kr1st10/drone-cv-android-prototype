"""Exact and conservative perceptual candidate edges; never delete annotations."""
from itertools import combinations

def duplicate_pairs(records, max_hamming=4, max_rgb_difference=5/255):
    pairs=[]
    for a,b in combinations(records,2):
        if a['sha256']==b['sha256'] or a['pixel_sha256']==b['pixel_sha256']:
            pairs.append({'a':a['id'],'b':b['id'],'kind':'exact_pixels_or_file','hamming':0,'rgb_difference':0.0})
            continue
        distance=(int(a['dhash64'],16)^int(b['dhash64'],16)).bit_count()
        if distance>max_hamming: continue
        aa=bytes.fromhex(a['mean_rgb_hex']);bb=bytes.fromhex(b['mean_rgb_hex'])
        difference=sum(abs(x-y) for x,y in zip(aa,bb))/(len(aa)*255)
        if difference<=max_rgb_difference:
            pairs.append({'a':a['id'],'b':b['id'],'kind':'near_candidate','hamming':distance,'rgb_difference':difference})
    return pairs

def reference_conflicts(records, reference):
    """Flag exact/near matches or matching provenance with an external dataset.

    Candidate matches are not proof; callers must quarantine and investigate.
    """
    conflicts=[]
    for a in records:
        for b in reference:
            reasons=[]
            if a['source_group']==b['source_group']:reasons.append('source_group')
            if a['sequence_id']==b['sequence_id']:reasons.append('sequence_id')
            if a.get('video_sha256') and a.get('video_sha256')==b.get('video_sha256'):reasons.append('video_sha256')
            matches=duplicate_pairs([a,b])
            if matches:reasons.append(matches[0]['kind'])
            if reasons:conflicts.append({'record_id':a['id'],'reference_id':b['id'],'reasons':reasons})
    return conflicts
