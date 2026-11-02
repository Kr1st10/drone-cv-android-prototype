import sys
from pathlib import Path
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from independent_prepare import sequence,classify
from independent_experiment import evaluate,summarize
from drone_detector import Detection

def ann(cls,box):return {'class':cls,'bbox':box}

def test_source_sequence_parsing():
 assert sequence('yt-AbcDef12345-0015_jpg.rf.abc.jpg')=='youtube:AbcDef12345'
 assert sequence('20190925_101846_1_1_072_jpg.rf.a.jpg')=='anti-uav:20190925_101846_1_1'
 assert sequence('V_DRONE_043153_278_png_jpg.rf.a.jpg')=='source-video:V_DRONE_043153'

def test_coco_classification_drone_takes_priority():
 assert classify([{'category_id':3,'bbox':[0,0,10,20]},{'category_id':2,'bbox':[0,0,2,2]}])=='lt16'
 assert classify([{'category_id':2,'bbox':[0,0,2,2]}])=='bird'
 assert classify([])=='empty'

def test_match_fp_and_non_drone_attribution():
 anns=[ann('drone',[10,10,20,20]),ann('bird',[60,60,20,20]),ann('airplane',[90,90,20,20])]
 dets=[Detection(10,10,30,30,.9),Detection(11,11,29,29,.8),Detection(60,60,80,80,.7),Detection(90,90,110,110,.6)]
 r=evaluate(dets,anns)
 assert (r['tp'],r['fp'],r['fn'])==(1,3,0)
 assert r['fp_overlap']=={'bird':1,'airplane':1} and r['hit']==[True]

def test_recall_denominator_and_negative_fp():
 rows={('test',1):{'annotations':[ann('drone',[0,0,10,10])]},('test',2):{'annotations':[ann('bird',[0,0,5,5])]}}
 records=[{'split':'test','id':1,'group':'lt16','tp':0,'fp':0,'fn':1,'sizes':[10],'hit':[False],'fp_overlap':{'bird':0,'airplane':0},'ms':10}, {'split':'test','id':2,'group':'bird','tp':0,'fp':1,'fn':0,'sizes':[],'hit':[],'fp_overlap':{'bird':1,'airplane':0},'ms':20}]
 s=summarize({'records':records,'peak_rss_kib':1,'model_sha256':'x'},rows)
 assert s['recall_by_size']['<16']=={'n':1,'tp':0,'recall':0.0}
 assert s['fp_negative']==1 and s['groups']['bird']['images_with_fp']==1 and s['precision']==0.0

def test_selection_enforces_sequence_and_visual_dedup():
 import cv2
 from independent_prepare import choose
 # AOD-like image bytes: same uniform image under different sequence IDs is rejected.
 images={'a':np.full((30,30,3),10,np.uint8),'b':np.full((30,30,3),10,np.uint8), 'c':np.full((30,30,3),100,np.uint8), 'd':np.full((30,30,3),200,np.uint8)}
 class Archive:
  def read(self,path):return cv2.imencode('.png',images[path.split('/')[-1]])[1].tobytes()
 def row(file,seq):return {'split':'test','file':file,'group':'lt16','sequence':seq}
 selected=choose([row('a','A'),row('b','B'),row('c','A'),row('d','D')],Archive())
 assert len({r['sequence'] for r in selected})==len(selected)
 # At most one of visually identical a and b can survive, regardless of hash ordering.
 assert len({'a','b'} & {r['file'] for r in selected})<=1
 assert 'd' in {r['file'] for r in selected}
