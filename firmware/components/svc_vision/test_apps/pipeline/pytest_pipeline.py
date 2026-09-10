"""Run the svc_vision pipeline suite on a board and fail the build when any case does."""

import pytest
from pytest_embedded_idf.dut import IdfDut


@pytest.mark.esp32s3
def test_pipeline(dut: IdfDut) -> None:
    dut.expect_unity_test_output(timeout=60)
