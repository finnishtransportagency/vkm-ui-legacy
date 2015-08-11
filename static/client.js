$(function() {
  var fileName = window.location.hash.substring(1);
  if (fileName) { pollResponse(fileName); }

  var loader = $("#loading");
  var ready = $("#ready");
  var error = $("#error");
  function handleReady(fileName, res) {
    $("#download").attr("href", downloadUrl(fileName));
    loader.addClass("hidden");
    ready.removeClass("hidden");
    error.addClass("hidden");
    if (res.errors) {
      ready.find(".errors").text("Virheellisiä rivejä " + res.errorCount +
          " kpl alkaen riviltä " + res.firstError + ".");
    } else {
      ready.find(".errors").empty();
    }
  }

  function handlePending() {
    loader.removeClass('hidden');
    ready.addClass("hidden");
    error.addClass("hidden");
  }

  function handleError(res) {
    loader.addClass("hidden");
    ready.addClass("hidden");
    error.removeClass("hidden");
  }

  function pollResponse(res) {
    $.ajax("/status/" + res, {
      statusCode: {
        200: function(response) { handleReady(res, response); },
        202: function() { handlePending(); setTimeout(function() { pollResponse(res); }, 1000); },
        500: function() { handleError(res); }
      }
    });
  }

  $('#upload').on('submit', function(event) {
    event.preventDefault();

    handlePending();

    $.ajax({
      url: '/upload',
      type: 'POST',
      data: new FormData($(this)[0]),
      cache: false,
      processData: false,
      contentType: false
    }).done(function(res) {
      window.location.hash = res;
      pollResponse(res);
    }).fail(handleError);
  });

  function downloadUrl(fileName) {
    return "download/" + fileName;
  }
});
