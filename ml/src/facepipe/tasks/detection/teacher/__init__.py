"""Detection teacher. Ultralytics is imported lazily so the branch loads without it."""

from .yolo26_pose_wrapper import FACE_KPT_SHAPE, TeacherDetections, check_face_head

__all__ = ["FACE_KPT_SHAPE", "TeacherDetections", "check_face_head"]
