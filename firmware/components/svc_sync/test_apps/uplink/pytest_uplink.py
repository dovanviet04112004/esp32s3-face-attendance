"""Run the svc_sync suite on a board and fail the build when any case does."""

import pytest
from pytest_embedded_idf.dut import IdfDut


@pytest.mark.esp32s3
def test_uplink(dut: IdfDut) -> None:
    dut.expect_unity_test_output(timeout=120)
