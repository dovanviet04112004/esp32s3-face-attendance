"""Detection teacher. Ultralytics is imported lazily so the branch loads without it."""

from .export_soft_target import SoftTarget, SoftTargetStore, read_shard, write_shards
from .yolo26_pose_wrapper import FACE_KPT_SHAPE, TeacherDetections, check_face_head

__all__ = [
    "FACE_KPT_SHAPE",
    "SoftTarget",
    "SoftTargetStore",
    "TeacherDetections",
    "check_face_head",
    "read_shard",
    "write_shards",
]
