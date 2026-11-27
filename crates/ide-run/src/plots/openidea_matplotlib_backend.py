"""matplotlib backend of OpenIDEA's Plots tool window (MPLBACKEND=module://openidea_matplotlib_backend).

plt.show() saves every open figure as a PNG in OPENIDEA_PLOTS_DIR, where the IDE picks it up, and
closes the figures; Figure.show() saves that figure.
"""

import itertools
import os
import time

from matplotlib._pylab_helpers import Gcf
from matplotlib.backend_bases import FigureManagerBase, _Backend
from matplotlib.backends.backend_agg import FigureCanvasAgg

_counter = itertools.count()


def _save(figure):
    directory = os.environ.get("OPENIDEA_PLOTS_DIR")
    if not directory:
        return
    os.makedirs(directory, exist_ok=True)
    name = "%d-%d-%d.png" % (time.time_ns(), os.getpid(), next(_counter))
    # Written under a hidden name first: the IDE reads only finished files.
    partial = os.path.join(directory, "." + name)
    figure.savefig(partial, format="png")
    os.replace(partial, os.path.join(directory, name))


class FigureManagerOpenidea(FigureManagerBase):
    def show(self):
        _save(self.canvas.figure)


class FigureCanvasOpenidea(FigureCanvasAgg):
    manager_class = FigureManagerOpenidea


@_Backend.export
class _BackendOpenidea(_Backend):
    FigureCanvas = FigureCanvasOpenidea
    FigureManager = FigureManagerOpenidea

    @staticmethod
    def show(*args, **kwargs):
        for manager in Gcf.get_all_fig_managers():
            _save(manager.canvas.figure)
        Gcf.destroy_all()
